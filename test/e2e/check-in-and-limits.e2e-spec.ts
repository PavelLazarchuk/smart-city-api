import { randomUUID } from 'node:crypto';

import { AutoNoShowJob } from '../../src/jobs/auto-no-show.job';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const DAY_MS = 24 * 60 * 60 * 1000;

const dateIn = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

function datedOption(dates: string[], time = '00:00', limit = 5) {
    const slots = dates.map((date) => ({
        id: randomUUID(),
        label: 'Date',
        child_type: 'date_time' as const,
        value: { date, time: [{ time, limit, booked_count: 0 }] },
    }));

    return {
        id: randomUUID(),
        label: 'Booking',
        service_type: 'service_apply' as const,
        enabled: true,
        slots,
        slot_ids: slots.map((slot) => slot.id),
    };
}

const policy = (overrides: Record<string, unknown> = {}) => ({
    max_active_per_user: null,
    lead_time_minutes: null,
    max_advance_days: null,
    cancel_deadline_minutes: null,
    late_cancel: 'forbid' as const,
    requires_confirmation: false,
    no_show_limit: null,
    no_show_window_days: null,
    no_show_suspension_days: null,
    ...overrides,
});

describe('check-in, auto no-show and client limits (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let operatorBearer: string;
    let client: FixtureUser;
    let clientBearer: string;

    const book = (
        serviceId: string,
        optionId: string,
        slotId: string,
        bearer = clientBearer,
        time = '00:00',
    ) =>
        t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: optionId, slot_id: slotId, time });

    const own = async (bookingId: string) =>
        (await t.http.get(`${t.prefix}/bookings/${bookingId}`).set('Authorization', clientBearer)).body.data;

    const checkInByCode = (code: string, bearer = operatorBearer) =>
        t.http.post(`${t.prefix}/bookings/check-in`).set('Authorization', bearer).send({ code });

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        operatorBearer = await fx.bearer(
            await fx.user({ role: 'operator', organization_ids: [organization.id] }),
        );
        client = await fx.client();
        clientBearer = await fx.bearer(client);
    });

    describe('check-in', () => {
        it('gives each booking a code and lets staff check the client in with it', async () => {
            const option = datedOption([dateIn(0)]);
            const { id: serviceId } = await fx.service(organization.id, { options: [option] });
            const created = await book(serviceId, option.id, option.slot_ids[0]!);
            expect(created.status).toBe(201);

            const booking = await own(created.body.data.booking_id as string);
            expect(booking.checkin_code).toMatch(/^[A-Z2-9]{6}$/);
            expect(booking.arrived_at).toBeNull();

            const spaced = `${(booking.checkin_code as string).slice(0, 3).toLowerCase()}-${(booking.checkin_code as string).slice(3)}`;
            const arrived = await checkInByCode(spaced);
            expect(arrived.status).toBe(200);
            expect(arrived.body.data).toMatchObject({ id: booking.id, status: 'arrived' });
            expect(arrived.body.data.arrived_at).toEqual(expect.any(String));

            const again = await checkInByCode(booking.checkin_code as string);
            expect(again.status).toBe(200);
            expect(again.body.data.arrived_at).toBe(arrived.body.data.arrived_at);

            expectError(
                await t.http.delete(`${t.prefix}/bookings/${booking.id}`).set('Authorization', clientBearer),
                422,
                'BOOKING_NOT_ACTIVE',
            );

            const completed = await t.http
                .patch(`${t.prefix}/bookings/${booking.id}/status`)
                .set('Authorization', operatorBearer)
                .send({ status: 'completed' });
            expect(completed.status).toBe(200);
            expect(completed.body.data.status).toBe('completed');

            const event = await fx
                .collection<{ payload: Record<string, unknown> }>('OutboxEvent')
                .findOne({ type: 'booking.status_changed', 'payload.status': 'arrived' })
                .lean();
            expect(event?.payload).toMatchObject({ previous_status: 'confirmed', booking_id: booking.id });
        });

        it('checks in by booking id, refuses other days and hides other organizations', async () => {
            const option = datedOption([dateIn(0), dateIn(1)]);
            const { id: serviceId } = await fx.service(organization.id, { options: [option] });
            const today = (await book(serviceId, option.id, option.slot_ids[0]!)).body.data
                .booking_id as string;
            const tomorrow = (await book(serviceId, option.id, option.slot_ids[1]!)).body.data
                .booking_id as string;

            expectError(
                await t.http
                    .post(`${t.prefix}/bookings/${tomorrow}/check-in`)
                    .set('Authorization', operatorBearer),
                422,
                'BOOKING_CHECK_IN_NOT_TODAY',
            );

            const stranger = await fx.bearer(
                await fx.user({ role: 'operator', organization_ids: [(await fx.organization()).id] }),
            );
            expectError(
                await t.http.post(`${t.prefix}/bookings/${today}/check-in`).set('Authorization', stranger),
                404,
                'BOOKING_NOT_FOUND',
            );
            expectError(await checkInByCode((await own(today)).checkin_code as string, stranger), 404);
            expectError(
                await t.http
                    .post(`${t.prefix}/bookings/${today}/check-in`)
                    .set('Authorization', clientBearer),
                403,
            );

            const res = await t.http
                .post(`${t.prefix}/bookings/${today}/check-in`)
                .set('Authorization', operatorBearer);
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('arrived');

            const stats = await t.http.get(`${t.prefix}/bookings/stats`).set('Authorization', operatorBearer);
            expect(stats.body.data.by_status).toMatchObject({ arrived: 1, confirmed: 1 });
        });

        it('refuses a malformed code and an unknown one', async () => {
            expectError(await checkInByCode('not a code!'), 400, 'VALIDATION_ERROR');
            expectError(await checkInByCode('AAAAAA'), 404, 'BOOKING_NOT_FOUND');
        });
    });

    describe('auto no-show', () => {
        it('marks overdue confirmed bookings and lets a late arrival be checked in the same day', async () => {
            const option = datedOption([dateIn(0)]);
            const { id: serviceId } = await fx.service(organization.id, {
                options: [option],
                booking_policy: policy({
                    no_show_after_minutes: 15,
                    no_show_limit: 1,
                    no_show_suspension_days: 7,
                }),
            });
            const plain = datedOption([dateIn(0)]);
            const { id: plainServiceId } = await fx.service(organization.id, { options: [plain] });
            const bookingId = (await book(serviceId, option.id, option.slot_ids[0]!)).body.data
                .booking_id as string;
            const plainId = (await book(plainServiceId, plain.id, plain.slot_ids[0]!)).body.data
                .booking_id as string;
            const job = t.app.get(AutoNoShowJob);

            expect(await job.execute(new Date(Date.now() - DAY_MS))).toEqual({
                services: 1,
                marked: 0,
                failed: 0,
            });
            expect(await job.execute(new Date(Date.now() + DAY_MS + 60_000))).toEqual({
                services: 1,
                marked: 1,
                failed: 0,
            });
            expect((await own(plainId)).status).toBe('confirmed');

            const marked = await own(bookingId);
            expect(marked.status).toBe('no_show');

            const event = await fx
                .collection<{ payload: Record<string, unknown>; internal: Record<string, unknown> | null }>(
                    'OutboxEvent',
                )
                .findOne({ type: 'booking.status_changed', 'payload.status': 'no_show' })
                .lean();
            expect(event?.payload).toMatchObject({ automatic: true, previous_status: 'confirmed' });

            const suspended = await t.http
                .get(`${t.prefix}/suspensions`)
                .set('Authorization', operatorBearer);
            expect(suspended.body.data).toHaveLength(1);

            const arrived = await checkInByCode(marked.checkin_code as string);
            expect(arrived.status).toBe(200);
            expect(arrived.body.data.status).toBe('arrived');

            const lifted = await t.http.get(`${t.prefix}/suspensions`).set('Authorization', operatorBearer);
            expect(lifted.body.data).toEqual([]);
        });

        it('stores and serves no_show_after_minutes on the service policy', async () => {
            const admin = await fx.bearer(await fx.admin([organization.id]));
            const { id: serviceId } = await fx.service(organization.id, {
                options: [datedOption([dateIn(1)])],
            });
            const res = await t.http
                .patch(`${t.prefix}/services/${serviceId}`)
                .set('Authorization', admin)
                .send({ booking_policy: policy({ no_show_after_minutes: 20, min_interval_days: 14 }) });

            expect(res.status).toBe(200);
            expect(res.body.data.booking_policy).toMatchObject({
                no_show_after_minutes: 20,
                min_interval_days: 14,
            });
        });
    });

    describe('client limits', () => {
        it('caps active bookings per organization, but not for staff booking on behalf', async () => {
            const superBearer = await fx.bearer(await fx.superAdmin());
            const patched = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', superBearer)
                .send({ booking_policy: { max_active_per_user: 1 } });
            expect(patched.status).toBe(200);
            expect(patched.body.data.booking_policy).toEqual({
                max_active_per_user: 1,
                min_interval_days: null,
            });

            const first = datedOption([dateIn(1)]);
            const second = datedOption([dateIn(2)]);
            const a = await fx.service(organization.id, { options: [first] });
            const b = await fx.service(organization.id, { options: [second] });

            expect((await book(a.id, first.id, first.slot_ids[0]!)).status).toBe(201);
            expectError(
                await book(b.id, second.id, second.slot_ids[0]!),
                422,
                'BOOKING_ORGANIZATION_LIMIT_REACHED',
            );

            const behalf = await t.http
                .post(`${t.prefix}/services/${b.id}/bookings`)
                .set('Authorization', operatorBearer)
                .send({
                    option_id: second.id,
                    slot_id: second.slot_ids[0],
                    time: '00:00',
                    on_behalf: { phone: client.phone, name: 'At the desk' },
                });
            expect(behalf.status).toBe(201);
        });

        it('keeps bookings of one service the minimum interval apart, ignoring cancelled ones', async () => {
            const option = datedOption([dateIn(1), dateIn(3), dateIn(9)]);
            const { id: serviceId } = await fx.service(organization.id, {
                options: [option],
                booking_policy: policy({ min_interval_days: 7 }),
            });
            const [day1, day3, day9] = option.slot_ids as [string, string, string];
            const first = await book(serviceId, option.id, day1);
            expect(first.status).toBe(201);

            const refused = await book(serviceId, option.id, day3);
            expectError(refused, 422, 'BOOKING_TOO_FREQUENT');
            expect(refused.body.error.details[0]).toMatchObject({ path: 'booking_policy.min_interval_days' });

            const moved = await t.http
                .post(`${t.prefix}/bookings/${first.body.data.booking_id as string}/reschedule`)
                .set('Authorization', clientBearer)
                .send({ slot_id: day3, time: '00:00' });
            expect(moved.status).toBe(200);

            expectError(await book(serviceId, option.id, day9), 422, 'BOOKING_TOO_FREQUENT');

            await t.http
                .delete(`${t.prefix}/bookings/${first.body.data.booking_id as string}`)
                .set('Authorization', clientBearer)
                .expect(204);
            expect((await book(serviceId, option.id, day9)).status).toBe(201);
        });

        it('applies the organization interval across its services', async () => {
            await fx
                .collection('Organization')
                .updateOne(
                    { _id: organization.id },
                    { $set: { booking_policy: { max_active_per_user: null, min_interval_days: 30 } } },
                );
            const first = datedOption([dateIn(1)]);
            const second = datedOption([dateIn(20)]);
            const a = await fx.service(organization.id, { options: [first] });
            const b = await fx.service(organization.id, { options: [second] });

            expect((await book(a.id, first.id, first.slot_ids[0]!)).status).toBe(201);

            const refused = await book(b.id, second.id, second.slot_ids[0]!);
            expectError(refused, 422, 'BOOKING_TOO_FREQUENT');
            expect(refused.body.error.details[0]).toMatchObject({
                path: 'organization.booking_policy.min_interval_days',
            });
        });
    });
});
