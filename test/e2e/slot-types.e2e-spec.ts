import { StaleBookingsJob } from '../../src/jobs/stale-bookings.job';
import { expectError } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

function nextMonday(): string {
    for (let offset = 1; ; offset += 1) {
        const date = dateOnly(offset);

        if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) return date;
    }
}

describe('slot subtypes: type matrix and time ranges (e2e)', () => {
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

    describe('service type and slot type matrix', () => {
        it('refuses a slot type that does not belong to the option service type', async () => {
            expectError(
                await createService({
                    options: [
                        { service_type: 'service_delivery', slots: [{ child_type: 'apply', value: {} }] },
                    ],
                }),
                422,
                'SLOT_TYPE_NOT_ALLOWED',
            );

            const created = await createService({
                options: [
                    {
                        service_type: 'service_delivery',
                        slots: [
                            { child_type: 'pickup', value: { description: 'Main office, 9-18' } },
                            { child_type: 'courier', value: { price: '50' } },
                        ],
                    },
                    { service_type: 'service_apply', slots: [{ child_type: 'apply', value: { limit: 3 } }] },
                ],
            });
            expect(created.status).toBe(201);
            const [delivery, apply] = created.body.data.options;
            expect(delivery.slots.map((slot: { child_type: string }) => slot.child_type)).toEqual([
                'pickup',
                'courier',
            ]);
            expect(delivery.slots[0].label).toBe('Pickup');
            const serviceId = created.body.data.id as string;

            expectError(
                await t.http
                    .post(`${t.prefix}/services/${serviceId}/options/${apply.id}/slots`)
                    .set('Authorization', bearer)
                    .send({ child_type: 'paycard', value: { price: '10' } }),
                422,
                'SLOT_TYPE_NOT_ALLOWED',
            );
            expectError(
                await t.http
                    .patch(`${t.prefix}/services/${serviceId}/options/${apply.id}`)
                    .set('Authorization', bearer)
                    .send({ service_type: 'service_payment' }),
                422,
                'SLOT_TYPE_NOT_ALLOWED',
            );
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${serviceId}/options/${delivery.id}/slots`)
                    .set('Authorization', bearer)
                    .send({ child_type: 'delivery', value: { description: 'x' } }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(
                await book(serviceId, { option_id: delivery.id, slot_id: delivery.slots[1].id }),
                422,
                'SLOT_NOT_BOOKABLE',
            );
        });
    });

    describe('time_range', () => {
        it('books intervals on the step grid and refuses overlaps, off-grid and too short ones', async () => {
            const service = await rangeService();
            const target = { option_id: service.option_id, slot_id: service.slot_id };

            const first = await book(service.id, { ...target, time: '10:00', end_time: '11:00' });
            expect(first.status).toBe(201);
            expect(first.body.data).toMatchObject({
                child_type: 'time_range',
                time: '10:00',
                end_time: '11:00',
            });

            expectError(
                await book(service.id, { ...target, time: '10:30', end_time: '11:30' }),
                422,
                'SLOT_FULL',
            );
            expectError(
                await book(service.id, { ...target, time: '08:15', end_time: '09:15' }),
                422,
                'SLOT_RANGE_INVALID',
            );
            expectError(
                await book(service.id, { ...target, time: '08:00', end_time: '08:30' }),
                422,
                'SLOT_RANGE_INVALID',
            );
            expectError(
                await book(service.id, { ...target, time: '13:00', end_time: '14:30' }),
                422,
                'SLOT_RANGE_INVALID',
            );
            expectError(await book(service.id, { ...target, time: '11:00' }), 422, 'SLOT_TIME_REQUIRED');
            expect((await book(service.id, { ...target, time: '11:00', end_time: '12:00' })).status).toBe(
                201,
            );

            const availability = await t.http.get(`${t.prefix}/services/${service.id}/availability`);
            expect(availability.status).toBe(200);
            const slot = availability.body.data.options[0].slots[0];
            expect(slot.range).toMatchObject({
                from: '08:00',
                to: '14:00',
                step_minutes: 30,
                min_minutes: 60,
            });
            expect(slot.range.free).toEqual([
                { from: '08:00', to: '10:00' },
                { from: '12:00', to: '14:00' },
            ]);

            const candidates = await t.http.get(`${t.prefix}/services/${service.id}/slots`);
            expect(candidates.body.data.items.map((item: { time: string }) => item.time)).toEqual([
                '08:00',
                '12:00',
            ]);
            expect(candidates.body.data.items[0]).toMatchObject({
                range: { step_minutes: 30, min_minutes: 60, max_minutes: null },
            });

            const publicView = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(publicView.body.data.options[0].slots[0].value.bookings).toEqual([
                { status: 'reserved' },
                { status: 'reserved' },
            ]);
            const adminView = await t.http
                .get(`${t.prefix}/services/${service.id}`)
                .set('Authorization', bearer);
            expect(adminView.body.data.options[0].slots[0].value.bookings).toEqual([
                expect.objectContaining({ time: '10:00', end_time: '11:00' }),
                expect.objectContaining({ time: '11:00', end_time: '12:00' }),
            ]);

            const cancelled = await t.http
                .delete(`${t.prefix}/bookings/${first.body.data.booking_id}`)
                .set('Authorization', bearer);
            expect(cancelled.status).toBeLessThan(300);
            expect((await book(service.id, { ...target, time: '09:30', end_time: '11:00' })).status).toBe(
                201,
            );
        });

        it('lets exactly one of several concurrent overlapping bookings through', async () => {
            const service = await rangeService();
            const clients = await Promise.all(Array.from({ length: 6 }, () => fx.client()));
            const results = await Promise.all(
                clients.map((client, index) =>
                    book(
                        service.id,
                        {
                            option_id: service.option_id,
                            slot_id: service.slot_id,
                            time: index % 2 === 0 ? '10:00' : '10:30',
                            end_time: '11:30',
                        },
                        client,
                    ),
                ),
            );
            expect(results.filter((res) => res.status === 201)).toHaveLength(1);

            for (const res of results.filter((item) => item.status !== 201))
                expectError(res, 422, 'SLOT_FULL');
        });

        it('keeps the service buffer free around every booking', async () => {
            const service = await rangeService({ buffer_minutes: 15 });
            const target = { option_id: service.option_id, slot_id: service.slot_id };
            expect((await book(service.id, { ...target, time: '10:00', end_time: '11:00' })).status).toBe(
                201,
            );
            expectError(
                await book(service.id, { ...target, time: '11:00', end_time: '12:00' }),
                422,
                'SLOT_FULL',
            );
            expect((await book(service.id, { ...target, time: '11:30', end_time: '12:30' })).status).toBe(
                201,
            );
        });

        it('takes the interval from working hours, reschedules, moves and survives the stale job', async () => {
            const res = await createService({
                working_hours: [{ day: 'monday', from: '09:00', to: '17:00' }],
                duration_minutes: 60,
                options: [{ service_type: 'service_apply', slots: [] }],
            });
            const serviceId = res.body.data.id as string;
            const optionId = res.body.data.options[0].id as string;
            const monday = nextMonday();
            const added = await t.http
                .post(`${t.prefix}/services/${serviceId}/options/${optionId}/slots`)
                .set('Authorization', bearer)
                .send({ child_type: 'time_range', value: { date: monday } });
            expect(added.status).toBe(201);
            const slot = added.body.data.options[0].slots[0];
            expect(slot.value).toMatchObject({
                from: '09:00',
                to: '17:00',
                step_minutes: 60,
                min_minutes: 60,
            });

            const client = await fx.client();
            const booked = await book(
                serviceId,
                { option_id: optionId, slot_id: slot.id, time: '10:00', end_time: '12:00' },
                client,
            );
            expect(booked.status).toBe(201);
            const bookingId = booked.body.data.booking_id as string;

            const rescheduled = await t.http
                .post(`${t.prefix}/bookings/${bookingId}/reschedule`)
                .set('Authorization', await fx.bearer(client))
                .send({ slot_id: slot.id, time: '11:00', end_time: '13:00' });
            expect(rescheduled.status).toBe(200);
            expect(rescheduled.body.data).toMatchObject({ time: '11:00', end_time: '13:00' });

            expect(await t.app.get(StaleBookingsJob).execute()).toEqual({ bookings_removed: 0 });

            const moved = await t.http
                .post(`${t.prefix}/services/${serviceId}/options/${optionId}/slots/${slot.id}/move`)
                .set('Authorization', bearer)
                .send({ date: monday, shift_minutes: 60, notify: false });
            expect(moved.status).toBe(200);
            expect(moved.body.data.moved).toBe(1);
            const after = await t.http.get(`${t.prefix}/bookings/${bookingId}`).set('Authorization', bearer);
            expect(after.body.data).toMatchObject({ time: '12:00', end_time: '14:00' });
            expect(after.body.data.ends_at).not.toBeNull();

            expectError(
                await t.http
                    .patch(`${t.prefix}/services/${serviceId}/options/${optionId}/slots/${slot.id}`)
                    .set('Authorization', bearer)
                    .send({ to: '13:00' }),
                409,
                'SLOT_TIME_BOOKED',
            );
            const widened = await t.http
                .patch(`${t.prefix}/services/${serviceId}/options/${optionId}/slots/${slot.id}`)
                .set('Authorization', bearer)
                .send({ to: '19:00' });
            expect(widened.status).toBe(200);
            expect(widened.body.data.options[0].slots[0].value.to).toBe('19:00');

            expectError(
                await t.http
                    .post(`${t.prefix}/services/${serviceId}/waitlist`)
                    .set('Authorization', await fx.bearer(await fx.client()))
                    .send({ option_id: optionId, slot_id: slot.id }),
                422,
                'WAITLIST_NOT_SUPPORTED',
            );

            const closed = await t.http
                .post(`${t.prefix}/services/${serviceId}/options/${optionId}/slots/${slot.id}/cancel`)
                .set('Authorization', bearer)
                .send({ notify: false });
            expect(closed.status).toBe(200);
            expect(closed.body.data.cancelled).toBe(1);
        });
    });
});
