import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { BookingRemindersJob } from '../../src/jobs/booking-reminders.job';
import { RecurrentSlotsJob } from '../../src/jobs/recurrent-slots.job';
import { expectError, waitFor } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function weekdayOf(date: string): (typeof WEEKDAY_NAMES)[number] {
    return WEEKDAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

describe('slot subtypes: callback, visits and recurrence (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
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
        bearer = await fx.bearer(admin);
    });

    const createService = (body: Record<string, unknown>) =>
        t.http
            .post(`${t.prefix}/services`)
            .set('Authorization', bearer)
            .send({ organization_id: organization.id, status: 'published', ...body });

    const rangeService = async (extra: Record<string, unknown> = {}, serviceType = 'service_apply') => {
        const res = await createService({
            ...extra,
            options: [
                {
                    service_type: serviceType,
                    slots: [
                        {
                            child_type: 'time_range',
                            value: {
                                date: dateOnly(1),
                                from: '08:00',
                                to: '14:00',
                                step_minutes: 30,
                                min_minutes: 60,
                            },
                        },
                    ],
                },
            ],
        });
        expect(res.status).toBe(201);
        const option = res.body.data.options[0];

        return {
            id: res.body.data.id as string,
            option_id: option.id as string,
            slot_id: option.slots[0].id as string,
        };
    };

    const book = async (serviceId: string, body: Record<string, unknown>, user?: FixtureUser) =>
        t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', await fx.bearer(user ?? (await fx.client())))
            .send(body);

    describe('callback', () => {
        it('books a call-back window and sends the operator, not the client, the reminder', async () => {
            const res = await createService({
                value: { heading_value: 'Consultation', subscribe: 'operator@example.com' },
                options: [
                    {
                        service_type: 'service_apply',
                        slots: [
                            {
                                child_type: 'callback',
                                value: {
                                    date: dateOnly(1),
                                    time: [{ time: '10:00', to: '12:00', limit: 1 }],
                                },
                            },
                        ],
                    },
                ],
            });
            expect(res.status).toBe(201);
            const option = res.body.data.options[0];
            const slot = option.slots[0];
            expect(slot.label).toBe('Call back');
            const target = { option_id: option.id, slot_id: slot.id, time: '10:00' };

            const booked = await book(res.body.data.id, target);
            expect(booked.status).toBe(201);
            expect(booked.body.data).toMatchObject({
                child_type: 'callback',
                time: '10:00',
                end_time: '12:00',
            });
            expectError(await book(res.body.data.id, target), 422, 'SLOT_FULL');

            const joined = await t.http
                .post(`${t.prefix}/services/${res.body.data.id}/waitlist`)
                .set('Authorization', await fx.bearer(await fx.client()))
                .send(target);
            expect(joined.status).toBe(201);

            const resource = await t.http
                .get(`${t.prefix}/bookings/${booked.body.data.booking_id}`)
                .set('Authorization', bearer);
            const startsAt = new Date(resource.body.data.starts_at as string);
            expect(resource.body.data.ends_at).toBe(
                new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
            );

            const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
            try {
                const outcome = await t.app
                    .get(BookingRemindersJob)
                    .execute(new Date(startsAt.getTime() - 3_600_000));
                expect(outcome.reminders).toBe(1);
                await waitFor(
                    async () =>
                        (await fx
                            .collection('OutboxEvent')
                            .countDocuments({ type: 'booking.callback_due', status: 'delivered' })) === 1,
                );
                expect(await fx.collection('OutboxEvent').countDocuments({ type: 'booking.reminder' })).toBe(
                    0,
                );
                expect(mail.mock.calls).toHaveLength(1);
                const message = mail.mock.calls[0]![0] as { to: string[]; text: string };
                expect(message.to).toEqual(['operator@example.com']);
                expect(message.text).toContain('10:00-12:00');
                expect(await fx.collection('Sms').countDocuments({ purpose: 'reminder' })).toBe(0);
            } finally {
                mail.mockRestore();
            }
        });

        it('requires an end time for a new window when times are edited', async () => {
            const res = await createService({
                options: [
                    {
                        service_type: 'service_apply',
                        slots: [
                            {
                                child_type: 'callback',
                                value: { date: dateOnly(1), time: [{ time: '10:00', to: '12:00' }] },
                            },
                        ],
                    },
                ],
            });
            const option = res.body.data.options[0];
            const path = `${t.prefix}/services/${res.body.data.id}/options/${option.id}/slots/${option.slots[0].id}`;
            expectError(
                await t.http
                    .patch(path)
                    .set('Authorization', bearer)
                    .send({ time: [{ time: '10:00' }, { time: '14:00' }] }),
                422,
                'SLOT_RANGE_REQUIRED',
            );
            const edited = await t.http
                .patch(path)
                .set('Authorization', bearer)
                .send({
                    time: [
                        { time: '10:00', to: '11:00' },
                        { time: '14:00', to: '16:00' },
                    ],
                });
            expect(edited.status).toBe(200);
            expect(edited.body.data.options[0].slots[0].value.time).toEqual([
                expect.objectContaining({ time: '10:00', to: '11:00' }),
                expect.objectContaining({ time: '14:00', to: '16:00' }),
            ]);

            const booked = await book(res.body.data.id as string, {
                option_id: option.id,
                slot_id: option.slots[0].id,
                time: '14:00',
            });
            expect(booked.status).toBe(201);
            expectError(
                await t.http
                    .patch(path)
                    .set('Authorization', bearer)
                    .send({
                        time: [
                            { time: '10:00', to: '11:00' },
                            { time: '14:00', to: '15:00' },
                        ],
                    }),
                409,
                'SLOT_TIME_BOOKED',
            );
        });
    });

    describe('service_visit', () => {
        it('requires an address and shows it only to the owner and the organization', async () => {
            const service = await rangeService({}, 'service_visit');
            const target = {
                option_id: service.option_id,
                slot_id: service.slot_id,
                time: '10:00',
                end_time: '11:00',
            };
            const client = await fx.client();

            expectError(await book(service.id, target, client), 422, 'BOOKING_ADDRESS_REQUIRED');
            const booked = await book(service.id, { ...target, address: 'Khreshchatyk 1, apt. 5' }, client);
            expect(booked.status).toBe(201);
            const bookingId = booked.body.data.booking_id as string;

            const own = await t.http
                .get(`${t.prefix}/bookings/${bookingId}`)
                .set('Authorization', await fx.bearer(client));
            expect(own.body.data.address).toBe('Khreshchatyk 1, apt. 5');
            const byAdmin = await t.http
                .get(`${t.prefix}/bookings/${bookingId}`)
                .set('Authorization', bearer);
            expect(byAdmin.body.data.address).toBe('Khreshchatyk 1, apt. 5');
            const stranger = await t.http
                .get(`${t.prefix}/bookings/${bookingId}`)
                .set('Authorization', await fx.bearer(await fx.client()));
            expect(stranger.status).toBe(404);

            const publicView = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(JSON.stringify(publicView.body)).not.toContain('Khreshchatyk');
            const adminView = await t.http
                .get(`${t.prefix}/services/${service.id}`)
                .set('Authorization', bearer);
            expect(adminView.body.data.options[0].slots[0].value.bookings[0].address).toBe(
                'Khreshchatyk 1, apt. 5',
            );

            const reschedule = (body: Record<string, unknown>) =>
                fx.bearer(client).then((auth) =>
                    t.http
                        .post(`${t.prefix}/bookings/${bookingId}/reschedule`)
                        .set('Authorization', auth)
                        .send({ slot_id: service.slot_id, ...body }),
                );
            const kept = await reschedule({ time: '11:00', end_time: '12:00' });
            expect(kept.status).toBe(200);
            expect(kept.body.data.address).toBe('Khreshchatyk 1, apt. 5');
            const readdressed = await reschedule({ time: '12:00', end_time: '13:00', address: 'Podil 2' });
            expect(readdressed.status).toBe(200);
            expect(readdressed.body.data.address).toBe('Podil 2');

            expectError(
                await t.http
                    .post(`${t.prefix}/services/${service.id}/options/${service.option_id}/slots`)
                    .set('Authorization', bearer)
                    .send({ child_type: 'apply', value: {} }),
                422,
                'SLOT_TYPE_NOT_ALLOWED',
            );
        });
    });

    describe('recurrent_ranges', () => {
        it('keeps one interval slot per resource and day, and follows schedule changes around bookings', async () => {
            const tomorrow = dateOnly(1);
            const day = weekdayOf(tomorrow);
            const created = await createService({
                duration_minutes: 60,
                working_hours: WEEKDAY_NAMES.map((name) => ({ day: name, from: '08:00', to: '20:00' })),
                options: [
                    {
                        service_type: 'service_visit',
                        recurrent_ranges: [{ day, resources: ['Anna', 'Boris'] }],
                    },
                    { service_type: 'service_delivery', slots: [{ child_type: 'pickup', value: {} }] },
                ],
            });
            expect(created.status).toBe(201);
            const serviceId = created.body.data.id as string;
            const [visit, delivery] = created.body.data.options as { id: string }[];
            expect(created.body.data.options[0].recurrent_ranges).toEqual([
                { day, resources: ['Anna', 'Boris'], max_minutes: null },
            ]);

            expectError(
                await t.http
                    .put(`${t.prefix}/services/${serviceId}/options/${delivery!.id}/recurrence`)
                    .set('Authorization', bearer)
                    .send({ recurrent_ranges: [{ day, from: '09:00', to: '18:00', resources: ['Van'] }] }),
                422,
                'SLOT_TYPE_NOT_ALLOWED',
            );
            expectError(
                await t.http
                    .patch(`${t.prefix}/services/${serviceId}/options/${visit!.id}`)
                    .set('Authorization', bearer)
                    .send({ service_type: 'service_payment' }),
                422,
                'SLOT_TYPE_NOT_ALLOWED',
            );

            const job = t.app.get(RecurrentSlotsJob);
            expect(await job.execute(new Date())).toEqual({ services_updated: 1 });
            expect(await job.execute(new Date())).toEqual({ services_updated: 0 });

            const generated = (await fx.storedSlots(serviceId)).filter(
                (slot) => slot.child_type === 'time_range',
            );
            const dates = [1, 8, 15, 22, 29].map((offset) => dateOnly(offset));
            expect(generated).toHaveLength(dates.length * 2);
            expect(generated.map((slot) => `${slot.value.date} ${slot.label}`).sort()).toEqual(
                dates.flatMap((date) => [`${date} Anna`, `${date} Boris`]).sort(),
            );
            expect(generated[0]!.value).toMatchObject({
                from: '08:00',
                to: '20:00',
                step_minutes: 60,
                min_minutes: 60,
                booked_count: 0,
            });

            const booked = generated.find(
                (slot) => slot.value.date === tomorrow && slot.value.resource === 'Anna',
            )!;
            const booking = await book(serviceId, {
                option_id: visit!.id,
                slot_id: booked.id,
                time: '10:00',
                end_time: '11:00',
                address: 'Main st. 1',
            });
            expect(booking.status).toBe(201);

            const changed = await t.http
                .put(`${t.prefix}/services/${serviceId}/options/${visit!.id}/recurrence`)
                .set('Authorization', bearer)
                .send({ recurrent_ranges: [{ day, from: '09:00', to: '18:00', resources: ['Anna'] }] });
            expect(changed.status).toBe(200);
            expect(await job.execute(new Date())).toEqual({ services_updated: 1 });

            const after = (await fx.storedSlots(serviceId)).filter(
                (slot) => slot.child_type === 'time_range',
            );
            expect(after.map((slot) => slot.value.resource)).toEqual(dates.map(() => 'Anna'));
            expect(after.find((slot) => slot.id === booked.id)!.value).toMatchObject({
                from: '08:00',
                to: '20:00',
            });
            expect(
                after.filter((slot) => slot.id !== booked.id).every((slot) => slot.value.from === '09:00'),
            ).toBe(true);

            const cleared = await t.http
                .put(`${t.prefix}/services/${serviceId}/options/${visit!.id}/recurrence`)
                .set('Authorization', bearer)
                .send({ recurrent_ranges: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.data.options[0].recurrent_ranges).toBeUndefined();
        });

        it('refuses a weekday that has neither from/to nor working hours', async () => {
            expectError(
                await createService({
                    options: [
                        {
                            service_type: 'service_apply',
                            recurrent_ranges: [{ day: 'monday', resources: ['Hall'] }],
                        },
                    ],
                }),
                422,
                'SLOT_RANGE_REQUIRED',
            );
        });
    });
});
