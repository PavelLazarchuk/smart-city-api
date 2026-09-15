import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { Types } from 'mongoose';

import { OutboxService } from '../../src/common/outbox/outbox.service';
import { BookingRemindersJob } from '../../src/jobs/booking-reminders.job';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

interface Received {
    headers: IncomingMessage['headers'];
    body: string;
}

async function receiver(): Promise<{
    url: string;
    received: Received[];
    status: { code: number };
    close(): Promise<void>;
}> {
    const received: Received[] = [];
    const status = { code: 200 };
    const server: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            received.push({ headers: req.headers, body });
            res.statusCode = status.code;
            res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}/hook`,
        received,
        status,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

const uuid = (n: number) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function dateOnly(offsetDays: number, base = new Date()): string {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);

    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

describe('booking lifecycle, policies, waitlist and outbox (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let citizen: FixtureUser;
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
        citizen = await fx.citizen({ name: 'Anna', phone: '375291234567' });
        bearer = await fx.bearer(citizen);
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

    describe('statuses and statistics', () => {
        it('confirms, completes and marks no-shows; stats count the outcomes', async () => {
            const service = await serviceWith({ booking_policy: { requires_confirmation: true } });
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            expect(created.status).toBe(201);
            expect(created.body.data.status).toBe('pending');
            const id = created.body.data.booking_id as string;
            const status = (value: string, token = adminBearer) =>
                t.http
                    .patch(`${t.prefix}/bookings/${id}/status`)
                    .set('Authorization', token)
                    .send({ status: value });

            expectError(await status('confirmed', bearer), 403);
            expectError(await status('completed'), 422, 'BOOKING_STATUS_TRANSITION');
            const confirmed = await status('confirmed');
            expect(confirmed.status).toBe(200);
            expect(confirmed.body.data.status).toBe('confirmed');
            expect(typeof confirmed.body.data.confirmed_at).toBe('string');

            const one = await t.http.get(`${t.prefix}/bookings/${id}`).set('Authorization', bearer);
            expect(one.body.data).toMatchObject({ id, status: 'confirmed', person: 'Anna' });
            expectError(
                await t.http
                    .get(`${t.prefix}/bookings/${id}`)
                    .set('Authorization', await fx.bearer(await fx.citizen())),
                404,
            );

            expect((await status('no_show')).body.data).toMatchObject({ status: 'no_show' });
            expect((await status('completed')).body.data).toMatchObject({ status: 'completed' });
            expectError(await status('cancelled'), 422, 'BOOKING_STATUS_TRANSITION');

            expect(
                (await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' })).status,
            ).toBe(201);
            const other = await fx.bearer(await fx.citizen());
            const cancelled = await book(service.id, { option_id: uuid(1), slot_id: uuid(3) }, other);
            await t.http
                .delete(`${t.prefix}/bookings/${cancelled.body.data.booking_id}`)
                .set('Authorization', other);

            const stats = await t.http
                .get(`${t.prefix}/bookings/stats?service_id=${service.id}`)
                .set('Authorization', adminBearer);
            expect(stats.status).toBe(200);
            expect(stats.body.data).toEqual({
                total: 3,
                by_status: { pending: 1, confirmed: 0, completed: 1, no_show: 0, cancelled: 1 },
                no_show_rate: 0,
                cancellation_rate: 0.5,
            });
            const active = await t.http
                .get(`${t.prefix}/bookings?status=active`)
                .set('Authorization', adminBearer);
            expect(active.body.data).toHaveLength(1);
            const all = await t.http.get(`${t.prefix}/bookings?status=all`).set('Authorization', adminBearer);
            expect(all.body.data).toHaveLength(3);
        });

        it('deleting the account keeps finished rows for the statistics without the person', async () => {
            const service = await serviceWith({});
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            await t.http
                .patch(`${t.prefix}/bookings/${created.body.data.booking_id}/status`)
                .set('Authorization', adminBearer)
                .send({ status: 'completed' });
            await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '11:00' });

            const superBearer = await fx.bearer(await fx.superAdmin());
            expect(
                (await t.http.delete(`${t.prefix}/users/${citizen.id}`).set('Authorization', superBearer))
                    .status,
            ).toBe(204);
            const rows = await fx
                .collection<{ status: string; person: string; phone: string }>('Booking')
                .find({})
                .lean();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'completed', person: '', phone: '' });
        });
    });

    describe('booking policy', () => {
        it('enforces lead time, advance window, the active limit and the cancellation deadline', async () => {
            const service = await serviceWith(
                {
                    booking_policy: {
                        lead_time_minutes: 3 * 24 * 60,
                        max_advance_days: 10,
                        max_active_per_user: 1,
                        cancel_deadline_minutes: 60,
                    },
                },
                2,
            );
            expectError(
                await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' }),
                422,
                'BOOKING_LEAD_TIME',
            );

            const far = await serviceWith({ booking_policy: { max_advance_days: 10 } }, 20);
            expectError(
                await book(far.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' }),
                422,
                'BOOKING_TOO_FAR_AHEAD',
            );

            const limited = await serviceWith({ booking_policy: { max_active_per_user: 1 } });
            expect(
                (await book(limited.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' })).status,
            ).toBe(201);
            expectError(
                await book(limited.id, { option_id: uuid(1), slot_id: uuid(3) }),
                422,
                'BOOKING_LIMIT_REACHED',
            );
            expect(
                (await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' }, adminBearer))
                    .status,
            ).toBe(201);

            const soon = await fx.service(organization.id, {
                booking_policy: {
                    max_active_per_user: null,
                    lead_time_minutes: null,
                    max_advance_days: null,
                    cancel_deadline_minutes: 48 * 60,
                    requires_confirmation: false,
                },
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
                                child_type: 'date',
                                value: { date: dateOnly(1), limit: null, booked_count: 0 },
                            },
                        ],
                    },
                ],
            });
            const created = await book(soon.id, { option_id: uuid(1), slot_id: uuid(2) });
            expect(created.status).toBe(201);
            expectError(
                await t.http
                    .delete(`${t.prefix}/bookings/${created.body.data.booking_id}`)
                    .set('Authorization', bearer),
                422,
                'BOOKING_CANCEL_DEADLINE_PASSED',
            );
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/bookings/${created.body.data.booking_id}`)
                        .set('Authorization', adminBearer)
                ).status,
            ).toBe(204);
        });

        it('validates the form answers and the confirmed documents', async () => {
            const service = await serviceWith({
                form_fields: [
                    {
                        key: 'reason',
                        label: 'Reason',
                        type: 'select',
                        required: true,
                        options: ['lost', 'expired'],
                    },
                    { key: 'age', label: 'Age', type: 'number' },
                ],
                required_documents: [{ key: 'passport', label: 'Passport', required: true }],
            });
            const target = { option_id: uuid(1), slot_id: uuid(3) };

            const invalid = await book(service.id, {
                ...target,
                fields: { reason: 'other', age: 'x', extra: 1 },
            });
            expectError(invalid, 422, 'BOOKING_FIELDS_INVALID');
            expect(invalid.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
                'fields.age',
                'fields.extra',
                'fields.reason',
            ]);
            const missing = await book(service.id, { ...target, fields: { reason: 'lost' } });
            expectError(missing, 422, 'BOOKING_DOCUMENTS_REQUIRED');
            expect(missing.body.error.details[0].path).toBe('documents.passport');

            const ok = await book(service.id, {
                ...target,
                fields: { reason: 'lost', age: 30 },
                documents: ['passport'],
            });
            expect(ok.status).toBe(201);
            const row = await t.http
                .get(`${t.prefix}/bookings/${ok.body.data.booking_id}`)
                .set('Authorization', adminBearer);
            expect(row.body.data).toMatchObject({
                fields: { reason: 'lost', age: 30 },
                documents: ['passport'],
            });
        });

        it('refuses a draft service and a temporarily closed organization to citizens', async () => {
            const draft = await serviceWith({ status: 'draft', enabled: false });
            expectError(
                await book(draft.id, { option_id: uuid(1), slot_id: uuid(3) }),
                422,
                'SERVICE_NOT_PUBLISHED',
            );
            expect((await book(draft.id, { option_id: uuid(1), slot_id: uuid(3) }, adminBearer)).status).toBe(
                201,
            );

            const service = await serviceWith({});
            await t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', adminBearer)
                .send({ status: 'temporarily_closed', closed_reason: 'Renovation' });
            expectError(
                await book(service.id, { option_id: uuid(1), slot_id: uuid(3) }),
                422,
                'ORGANIZATION_CLOSED',
            );
        });
    });

    describe('reschedule', () => {
        it('moves the booking in one transaction and leaves it untouched when the target is full', async () => {
            const service = await serviceWith({}, 2, '10:00', 1);
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            const id = created.body.data.booking_id as string;
            const counts = async () => {
                const stored = await fx
                    .collection<{ options: { slots: { value: { time?: { booked_count: number }[] } }[] }[] }>(
                        'Service',
                    )
                    .findById(service.id)
                    .lean();

                return stored!.options[0]!.slots[0]!.value.time!.map((entry) => entry.booked_count);
            };
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
                        await fx.bearer(await fx.citizen()),
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

            const holder = await fx.bearer(await fx.citizen());
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
            const second = await fx.bearer(await fx.citizen({ phone: '375297777777' }));
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
                        .countDocuments({ purpose: 'waitlist', phone: '375291234567' })) === 1,
            );

            expect((await book(service.id, target)).status).toBe(201);
            expect(
                await fx
                    .collection('WaitlistEntry')
                    .countDocuments({ user_id: new Types.ObjectId(citizen.id) }),
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

    describe('reminders', () => {
        it('emits one reminder per active booking of the target day, once', async () => {
            const service = await serviceWith({}, 1);
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            await book(service.id, { option_id: uuid(1), slot_id: uuid(3) });
            const job = t.app.get(BookingRemindersJob);
            expect(await job.execute(new Date())).toEqual({ date: dateOnly(1), reminders: 1 });
            expect(await job.execute(new Date())).toEqual({ date: dateOnly(1), reminders: 0 });
            const row = await fx
                .collection<{ reminder_sent_at: Date | null }>('Booking')
                .findOne({ id: created.body.data.booking_id })
                .lean();
            expect(row?.reminder_sent_at).toBeInstanceOf(Date);
            await waitFor(
                async () => (await fx.collection('Sms').countDocuments({ purpose: 'reminder' })) === 1,
            );
            const sms = await fx.collection<{ phone: string }>('Sms').findOne({ purpose: 'reminder' }).lean();
            expect(sms?.phone).toBe('375291234567');
        });
    });

    describe('outbox and webhooks', () => {
        it('delivers a signed booking.created event to the organization hook and retries a failing one', async () => {
            const hook = await receiver();
            try {
                const created = await t.http
                    .post(`${t.prefix}/webhooks`)
                    .set('Authorization', adminBearer)
                    .send({
                        organization_id: organization.id,
                        url: hook.url,
                        events: ['booking.created', 'booking.cancelled'],
                    });
                expect(created.status).toBe(201);
                expect(created.body.data.secret).toMatch(/^whsec_/);
                const secret = created.body.data.secret as string;
                const webhookId = created.body.data.id as string;
                expect(
                    (await t.http.get(`${t.prefix}/webhooks/${webhookId}`).set('Authorization', adminBearer))
                        .body.data.secret,
                ).toBeUndefined();
                expectError(
                    await t.http
                        .post(`${t.prefix}/webhooks`)
                        .set('Authorization', adminBearer)
                        .send({ url: hook.url, events: ['booking.created'] }),
                    403,
                );
                expectError(
                    await t.http
                        .post(`${t.prefix}/webhooks`)
                        .set('Authorization', adminBearer)
                        .send({
                            organization_id: organization.id,
                            url: 'ftp://x/y',
                            events: ['booking.created'],
                        }),
                    400,
                    'VALIDATION_ERROR',
                );

                const service = await serviceWith({
                    value: { heading_value: 'Therapist', subscribe: 'clinic@example.com' },
                });
                const booking = await book(service.id, {
                    option_id: uuid(1),
                    slot_id: uuid(2),
                    time: '10:00',
                });
                expect(booking.status).toBe(201);
                await waitFor(() => Promise.resolve(hook.received.length === 1));
                const [delivery] = hook.received;
                const body = JSON.parse(delivery!.body) as { type: string; data: Record<string, unknown> };
                expect(body.type).toBe('booking.created');
                expect(body.data).toMatchObject({
                    booking_id: booking.body.data.booking_id,
                    service_id: service.id,
                    status: 'confirmed',
                });
                expect(JSON.stringify(body)).not.toContain('375291234567');
                expect(JSON.stringify(body)).not.toContain('clinic@example.com');
                const timestamp = delivery!.headers['x-webhook-timestamp'] as string;
                expect(delivery!.headers['x-webhook-signature']).toBe(
                    `sha256=${createHmac('sha256', secret).update(`${timestamp}.${delivery!.body}`).digest('hex')}`,
                );
                expect(delivery!.headers['x-webhook-event']).toBe('booking.created');

                const events = await t.http
                    .get(`${t.prefix}/outbox/events?type=booking.created`)
                    .set('Authorization', adminBearer);
                expect(events.body.data).toHaveLength(1);
                expect(events.body.data[0]).toMatchObject({ status: 'delivered' });
                expect(
                    events.body.data[0].deliveries.map((d: { target: string; status: string }) => [
                        d.target.split(':')[0],
                        d.status,
                    ]),
                ).toEqual([
                    ['handler', 'delivered'],
                    ['webhook', 'delivered'],
                ]);

                hook.status.code = 500;
                await t.http
                    .delete(`${t.prefix}/bookings/${booking.body.data.booking_id}`)
                    .set('Authorization', bearer);
                await waitFor(() => Promise.resolve(hook.received.length === 2));
                await waitFor(
                    async () =>
                        (await fx
                            .collection('OutboxEvent')
                            .countDocuments({ type: 'booking.cancelled', attempts: 1 })) === 1,
                );
                const pending = await fx
                    .collection<{ status: string; next_attempt_at: Date; last_error: string }>('OutboxEvent')
                    .findOne({ type: 'booking.cancelled' })
                    .lean();
                expect(pending).toMatchObject({ status: 'pending' });
                expect(pending!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
                expect(pending!.last_error).toContain('HTTP 500');
                const hookRow = await t.http
                    .get(`${t.prefix}/webhooks/${webhookId}`)
                    .set('Authorization', adminBearer);
                expect(hookRow.body.data.consecutive_failures).toBe(1);

                hook.status.code = 204;
                const summary = await t.app.get(OutboxService).dispatch(new Date(Date.now() + 10 * 60_000));
                expect(summary).toMatchObject({ processed: 1, delivered: 1 });
                expect(hook.received).toHaveLength(3);

                const test = await t.http
                    .post(`${t.prefix}/webhooks/${webhookId}/test`)
                    .set('Authorization', adminBearer);
                expect(test.status).toBe(202);
                await waitFor(() => Promise.resolve(hook.received.length === 4));
                expect((JSON.parse(hook.received[3]!.body) as { type: string }).type).toBe('webhook.test');

                const rotated = await t.http
                    .post(`${t.prefix}/webhooks/${webhookId}/rotate-secret`)
                    .set('Authorization', adminBearer);
                expect(rotated.body.data.secret).not.toBe(secret);
                expect(
                    (
                        await t.http
                            .delete(`${t.prefix}/webhooks/${webhookId}`)
                            .set('Authorization', adminBearer)
                    ).status,
                ).toBe(204);
            } finally {
                await hook.close();
            }
        });
    });
});
