import { Types } from 'mongoose';

import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { BookingRemindersJob } from '../../src/jobs/booking-reminders.job';
import { expectError, waitFor } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const uuid = (n: number) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function hourBefore(date: string, time: string): Date {
    return new Date(Date.parse(`${date}T${time}:00Z`) - 3_600_000);
}

function remindedUntil(now: Date): string {
    return new Date(now.getTime() + 24 * 3_600_000).toISOString();
}

describe('booking reschedule, waitlist and reminders (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let client: FixtureUser;
    let bearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
        client = await fx.client({ name: 'Anna', phone: '4915291234567' });
        bearer = await fx.bearer(client);
    });

    const book = (serviceId: string, body: Record<string, unknown>, token = bearer) =>
        t.http.post(`${t.prefix}/services/${serviceId}/bookings`).set('Authorization', token).send(body);

    const serviceWith = (
        overrides: Record<string, unknown>,
        days = 2,
        time = '10:00',
        limit: number | null = 2,
    ) =>
        fx.service(organization.id, {
            options: [
                {
                    id: uuid(1),
                    label: 'x',
                    service_type: 'service_apply',
                    enabled: true,
                    slots: [
                        {
                            id: uuid(2),
                            label: 'd',
                            child_type: 'date_time',
                            value: {
                                date: dateOnly(days),
                                time: [
                                    { time, limit, booked_count: 0 },
                                    { time: '11:00', limit, booked_count: 0 },
                                ],
                            },
                        },
                        {
                            id: uuid(3),
                            label: 'a',
                            child_type: 'apply',
                            value: { limit: null, booked_count: 0 },
                        },
                    ],
                },
            ],
            ...overrides,
        });

    describe('reschedule', () => {
        it('moves the booking in one transaction and leaves it untouched when the target is full', async () => {
            const service = await serviceWith({}, 2, '10:00', 1);
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            const id = created.body.data.booking_id as string;
            const counts = async () =>
                (await fx.storedSlot(service.id)).value.time!.map((entry) => entry.booked_count);
            expect(await counts()).toEqual([1, 0]);

            const moved = await t.http
                .post(`${t.prefix}/bookings/${id}/reschedule`)
                .set('Authorization', bearer)
                .send({ slot_id: uuid(2), time: '11:00' });
            expect(moved.status).toBe(200);
            expect(moved.body.data).toMatchObject({ id, time: '11:00', status: 'confirmed' });
            expect(await counts()).toEqual([0, 1]);

            expect(
                (
                    await book(
                        service.id,
                        { option_id: uuid(1), slot_id: uuid(2), time: '10:00' },
                        await fx.bearer(await fx.client()),
                    )
                ).status,
            ).toBe(201);
            expectError(
                await t.http
                    .post(`${t.prefix}/bookings/${id}/reschedule`)
                    .set('Authorization', bearer)
                    .send({ slot_id: uuid(2), time: '10:00' }),
                422,
                'SLOT_FULL',
            );
            expect(await counts()).toEqual([1, 1]);
            expectError(
                await t.http
                    .post(`${t.prefix}/bookings/${id}/reschedule`)
                    .set('Authorization', bearer)
                    .send({ slot_id: uuid(2), time: '11:00' }),
                409,
                'BOOKING_ALREADY_EXISTS',
            );
            const events = await fx
                .collection<{ type: string }>('OutboxEvent')
                .find({ type: 'booking.rescheduled' })
                .lean();
            expect(events).toHaveLength(1);
        });
    });

    describe('waitlist', () => {
        it('queues for a full slot, tells the first in line when a place frees up, and lets people leave', async () => {
            const service = await serviceWith({}, 2, '10:00', 1);
            const target = { option_id: uuid(1), slot_id: uuid(2), time: '10:00' };
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${service.id}/waitlist`)
                    .set('Authorization', bearer)
                    .send(target),
                422,
                'SLOT_NOT_FULL',
            );

            const holder = await fx.bearer(await fx.client());
            const held = await book(service.id, target, holder);
            expect(held.status).toBe(201);

            const joined = await t.http
                .post(`${t.prefix}/services/${service.id}/waitlist`)
                .set('Authorization', bearer)
                .send(target);
            expect(joined.status).toBe(201);
            expect(joined.body.data).toMatchObject({ status: 'waiting', time: '10:00', person: 'Anna' });
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${service.id}/waitlist`)
                    .set('Authorization', bearer)
                    .send(target),
                409,
                'WAITLIST_ALREADY_JOINED',
            );
            const second = await fx.bearer(await fx.client({ phone: '4915297777777' }));
            expect(
                (
                    await t.http
                        .post(`${t.prefix}/services/${service.id}/waitlist`)
                        .set('Authorization', second)
                        .send(target)
                ).status,
            ).toBe(201);

            const mine = await t.http.get(`${t.prefix}/me/waitlist`).set('Authorization', bearer);
            expect(mine.body.data).toHaveLength(1);
            const forService = await t.http
                .get(`${t.prefix}/services/${service.id}/waitlist`)
                .set('Authorization', adminBearer);
            expect(forService.body.data).toHaveLength(2);

            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/bookings/${held.body.data.booking_id}`)
                        .set('Authorization', holder)
                ).status,
            ).toBe(204);
            const notified = await fx
                .collection<{ status: string; phone: string }>('WaitlistEntry')
                .findOne({ id: joined.body.data.id })
                .lean();
            expect(notified?.status).toBe('notified');
            expect(await fx.collection('WaitlistEntry').countDocuments({ status: 'waiting' })).toBe(1);
            await waitFor(
                async () =>
                    (await fx
                        .collection('Sms')
                        .countDocuments({ purpose: 'waitlist', phone: '4915291234567' })) === 1,
            );

            expect((await book(service.id, target)).status).toBe(201);
            expect(
                await fx
                    .collection('WaitlistEntry')
                    .countDocuments({ user_id: new Types.ObjectId(client.id) }),
            ).toBe(0);

            const remaining = await t.http.get(`${t.prefix}/me/waitlist`).set('Authorization', second);
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/waitlist/${remaining.body.data[0].id}`)
                        .set('Authorization', bearer)
                ).status,
            ).toBe(404);
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/waitlist/${remaining.body.data[0].id}`)
                        .set('Authorization', second)
                ).status,
            ).toBe(204);
        });
    });

    describe('waitlist notice channel', () => {
        it('tells the first in line by e-mail when the account has one', async () => {
            const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);

            try {
                const service = await serviceWith({}, 2, '10:00', 1);
                const target = { option_id: uuid(1), slot_id: uuid(2), time: '10:00' };
                const holder = await fx.bearer(await fx.client());
                const held = await book(service.id, target, holder);
                expect(held.status).toBe(201);
                expect(
                    (
                        await t.http
                            .patch(`${t.prefix}/users/${client.id}`)
                            .set('Authorization', bearer)
                            .send({ email: 'anna@example.com' })
                    ).status,
                ).toBe(200);
                expect(
                    (
                        await t.http
                            .post(`${t.prefix}/services/${service.id}/waitlist`)
                            .set('Authorization', bearer)
                            .send(target)
                    ).status,
                ).toBe(201);
                expect(
                    (
                        await t.http
                            .delete(`${t.prefix}/bookings/${held.body.data.booking_id}`)
                            .set('Authorization', holder)
                    ).status,
                ).toBe(204);

                await waitFor(
                    async () =>
                        (await fx
                            .collection('OutboxEvent')
                            .countDocuments({ type: 'waitlist.slot_available', status: 'delivered' })) === 1,
                );
                expect(mail.mock.calls).toHaveLength(1);
                const message = mail.mock.calls[0]![0] as { to: string[]; text: string };
                expect(message.to).toEqual(['anna@example.com']);
                expect(message.text).toContain('4915291234567');
                expect(await fx.collection('Sms').countDocuments({ purpose: 'waitlist' })).toBe(0);
            } finally {
                mail.mockRestore();
            }
        });
    });

    describe('reminders', () => {
        it('emits one reminder per active booking of the target day, once', async () => {
            const service = await serviceWith({}, 1);
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            await book(service.id, { option_id: uuid(1), slot_id: uuid(3) });
            const job = t.app.get(BookingRemindersJob);
            const now = hourBefore(dateOnly(1), '10:00');
            expect(await job.execute(now)).toEqual({ until: remindedUntil(now), reminders: 1 });
            expect(await job.execute(now)).toEqual({ until: remindedUntil(now), reminders: 0 });
            const row = await fx
                .collection<{ reminder_sent_at: Date | null }>('Booking')
                .findOne({ id: created.body.data.booking_id })
                .lean();
            expect(row?.reminder_sent_at).toBeInstanceOf(Date);
            await waitFor(
                async () => (await fx.collection('Sms').countDocuments({ purpose: 'reminder' })) === 1,
            );
            const sms = await fx.collection<{ phone: string }>('Sms').findOne({ purpose: 'reminder' }).lean();
            expect(sms?.phone).toBe('4915291234567');
        });

        it('skips the SMS reminder for a client who turned reminders off, keeping the in-app one', async () => {
            const muted = await t.http
                .patch(`${t.prefix}/me`)
                .set('Authorization', bearer)
                .send({ reminders: false });
            expect(muted.status).toBe(200);
            expect(muted.body.data.reminders).toBe(false);

            const service = await serviceWith({}, 1);
            await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            const now = hourBefore(dateOnly(1), '10:00');
            expect(await t.app.get(BookingRemindersJob).execute(now)).toEqual({
                until: remindedUntil(now),
                reminders: 1,
            });
            await waitFor(
                async () =>
                    (await fx
                        .collection('OutboxEvent')
                        .countDocuments({ type: 'booking.reminder', status: 'delivered' })) === 1,
            );
            expect(await fx.collection('Sms').countDocuments({ purpose: 'reminder' })).toBe(0);
            expect(await fx.collection('Notification').countDocuments({ type: 'booking_reminder' })).toBe(1);

            const back = await t.http
                .patch(`${t.prefix}/me`)
                .set('Authorization', bearer)
                .send({ reminders: true });
            expect(back.body.data.reminders).toBe(true);
        });

        it('sends the reminder by e-mail when the account has one, naming the booking phone', async () => {
            const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);

            try {
                const withEmail = await t.http
                    .patch(`${t.prefix}/users/${client.id}`)
                    .set('Authorization', bearer)
                    .send({ email: 'anna@example.com' });
                expect(withEmail.status).toBe(200);

                const service = await serviceWith({}, 1);
                await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
                const job = t.app.get(BookingRemindersJob);
                const now = hourBefore(dateOnly(1), '10:00');
                expect(await job.execute(now)).toEqual({ until: remindedUntil(now), reminders: 1 });
                await waitFor(
                    async () =>
                        (await fx
                            .collection('OutboxEvent')
                            .countDocuments({ type: 'booking.reminder', status: 'delivered' })) === 1,
                );
                expect(mail.mock.calls).toHaveLength(1);
                const message = mail.mock.calls[0]![0] as { to: string[]; text: string };
                expect(message.to).toEqual(['anna@example.com']);
                expect(message.text).toContain('4915291234567');
                expect(await fx.collection('Sms').countDocuments({ purpose: 'reminder' })).toBe(0);
            } finally {
                mail.mockRestore();
            }
        });
    });
});
