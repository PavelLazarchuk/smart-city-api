import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('no-show sanctions (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let operatorBearer: string;
    let client: FixtureUser;
    let clientBearer: string;
    let option: ReturnType<Fixtures['bookableOption']>;
    let serviceId: string;

    const policy = (overrides: Record<string, number | string | null> = {}) => ({
        max_active_per_user: null,
        lead_time_minutes: null,
        max_advance_days: null,
        cancel_deadline_minutes: null,
        late_cancel: 'forbid' as const,
        requires_confirmation: false,
        no_show_limit: 2,
        no_show_window_days: 30,
        no_show_suspension_days: 7,
        ...overrides,
    });

    const seedBooking = (status: 'confirmed' | 'no_show' = 'confirmed') =>
        fx.booking({
            service_id: serviceId,
            organization_id: organization.id,
            option_id: option.id,
            slot_id: option.slot_id,
            user_id: client.id,
            phone: client.phone,
            time: '10:00',
            status,
        });

    const mark = (bookingId: string, status: string, bearer = operatorBearer) =>
        t.http
            .patch(`${t.prefix}/bookings/${bookingId}/status`)
            .set('Authorization', bearer)
            .send({ status });

    const missTwice = async (): Promise<string[]> => {
        const ids: string[] = [];

        for (let i = 0; i < 2; i += 1) {
            const { id } = await seedBooking();
            expect((await mark(id, 'no_show')).status).toBe(200);
            ids.push(id);
        }

        return ids;
    };

    const book = (bearer = clientBearer, body: Record<string, unknown> = {}) =>
        t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00', ...body });

    const suspensions = (query = '', bearer = operatorBearer) =>
        t.http.get(`${t.prefix}/suspensions${query}`).set('Authorization', bearer);

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
        client = await fx.client({ email: 'client@example.com' });
        clientBearer = await fx.bearer(client);
        option = fx.bookableOption(5);
        serviceId = (await fx.service(organization.id, { options: [option], booking_policy: policy() })).id;
    });

    it('suspends the client once the limit is reached and refuses new bookings and the waitlist', async () => {
        const { id: first } = await seedBooking();
        expect((await mark(first, 'no_show')).status).toBe(200);
        expect((await suspensions()).body.data).toEqual([]);

        const { id: second } = await seedBooking();
        expect((await mark(second, 'no_show')).status).toBe(200);

        const listed = await suspensions();
        expect(listed.body.data).toHaveLength(1);
        expect(listed.body.data[0]).toMatchObject({
            user_id: client.id,
            service_id: serviceId,
            active: true,
            kind: 'no_show',
            suspended_by: null,
        });
        expect([...listed.body.data[0].booking_ids].sort()).toEqual([first, second].sort());
        const until = new Date(listed.body.data[0].until as string).getTime();
        expect(Math.abs(until - (Date.now() + 7 * DAY_MS))).toBeLessThan(60_000);

        const refused = await book();
        expectError(refused, 422, 'BOOKING_SUSPENDED');
        expect(refused.body.error.details[0]).toMatchObject({ path: 'until' });
        expectError(
            await t.http
                .post(`${t.prefix}/services/${serviceId}/waitlist`)
                .set('Authorization', clientBearer)
                .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' }),
            422,
            'BOOKING_SUSPENDED',
        );

        const event = await fx
            .collection<{ payload: Record<string, unknown>; internal: Record<string, unknown> }>(
                'OutboxEvent',
            )
            .findOne({ type: 'booking.suspended' })
            .lean();
        expect(event?.payload).toMatchObject({ user_id: client.id, kind: 'no_show' });
        expect(event?.internal).toMatchObject({ email: 'client@example.com', phone: client.phone });
    });

    it('lets staff book on behalf of a suspended client', async () => {
        await missTwice();

        const res = await book(operatorBearer, { on_behalf: { phone: client.phone, name: 'At the desk' } });

        expect(res.status).toBe(201);
        expect(res.body.data.user_id).toBe(client.id);
    });

    it('lifts the suspension when one of its no-shows is corrected', async () => {
        const [, second] = await missTwice();

        expect((await mark(second!, 'completed')).status).toBe(200);

        expect((await suspensions()).body.data).toEqual([]);
        const all = await suspensions('?status=all');
        expect(all.body.data[0]).toMatchObject({ active: false });
        expect(all.body.data[0].lifted_at).not.toBeNull();
        expect((await book()).status).toBe(201);
        expect(await fx.collection('OutboxEvent').countDocuments({ type: 'booking.suspension_lifted' })).toBe(
            1,
        );
    });

    it('starts counting afresh after a suspension is lifted', async () => {
        await missTwice();
        const [row] = (await suspensions()).body.data as { id: string }[];

        const lifted = await t.http
            .delete(`${t.prefix}/suspensions/${row!.id}`)
            .set('Authorization', operatorBearer);
        expect(lifted.status).toBe(204);

        const { id } = await seedBooking();
        expect((await mark(id, 'no_show')).status).toBe(200);

        expect((await suspensions()).body.data).toEqual([]);
        expect((await book()).status).toBe(201);
    });

    it('ignores no-shows outside the window', async () => {
        const { id } = await seedBooking('no_show');
        await fx
            .collection('Booking')
            .updateOne({ id }, { $set: { finished_at: new Date(Date.now() - 60 * DAY_MS) } });

        const { id: recent } = await seedBooking();
        expect((await mark(recent, 'no_show')).status).toBe(200);

        expect((await suspensions()).body.data).toEqual([]);
    });

    it('does nothing for a service without sanctions', async () => {
        await fx
            .collection('Service')
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                { $set: { booking_policy: policy({ no_show_limit: null, no_show_suspension_days: null }) } },
            );

        await missTwice();

        expect((await suspensions()).body.data).toEqual([]);
        expect(await fx.collection('BookingSuspension').countDocuments()).toBe(0);
    });

    it('suspends by hand without no-shows, until lifted when no days are given', async () => {
        const created = await t.http
            .post(`${t.prefix}/suspensions`)
            .set('Authorization', operatorBearer)
            .send({ service_id: serviceId, phone: client.phone, reason: 'Rude to the staff' });

        expect(created.status).toBe(201);
        expect(created.headers['location']).toBe(`/suspensions/${created.body.data.id as string}`);
        expect(
            (
                await t.http
                    .get(`${t.prefix}/suspensions/${created.body.data.id as string}`)
                    .set('Authorization', operatorBearer)
            ).body.data,
        ).toMatchObject({ id: created.body.data.id, active: true });
        expect(created.body.data).toMatchObject({
            user_id: client.id,
            active: true,
            kind: 'manual',
            reason: 'Rude to the staff',
            until: null,
            booking_ids: [],
        });
        expectError(await book(), 422, 'BOOKING_SUSPENDED');

        const event = await fx
            .collection<{ payload: Record<string, unknown>; internal: unknown }>('OutboxEvent')
            .findOne({ type: 'booking.suspended' })
            .lean();
        expect(event?.payload).toMatchObject({ kind: 'manual', reason: 'Rude to the staff', until: null });
        expect(event?.internal).not.toBeNull();

        const lifted = await t.http
            .delete(`${t.prefix}/suspensions/${created.body.data.id as string}`)
            .set('Authorization', operatorBearer);
        expect(lifted.status).toBe(204);
        expect((await book()).status).toBe(201);
    });

    it('takes days and user_id, and stays silent with notify false', async () => {
        const created = await t.http
            .post(`${t.prefix}/suspensions`)
            .set('Authorization', operatorBearer)
            .send({
                service_id: serviceId,
                user_id: client.id,
                days: 3,
                reason: 'Repeated fraud',
                notify: false,
            });

        expect(created.status).toBe(201);
        const until = new Date(created.body.data.until as string).getTime();
        expect(Math.abs(until - (Date.now() + 3 * DAY_MS))).toBeLessThan(60_000);

        const event = await fx
            .collection<{ internal: Record<string, unknown> | null }>('OutboxEvent')
            .findOne({ type: 'booking.suspended' })
            .lean();
        expect(event?.internal).not.toHaveProperty('phone');
        expect(event?.internal).not.toHaveProperty('email');
    });

    it('a no-show does not cut short a manual suspension without an end', async () => {
        await t.http
            .post(`${t.prefix}/suspensions`)
            .set('Authorization', operatorBearer)
            .send({ service_id: serviceId, user_id: client.id, reason: 'Banned' });

        await missTwice();

        const [row] = (await suspensions()).body.data as { kind: string; until: string | null }[];
        expect(row).toMatchObject({ kind: 'manual', until: null });
    });

    it('extends a manual suspension with an end without turning it into a no-show one', async () => {
        await t.http
            .post(`${t.prefix}/suspensions`)
            .set('Authorization', operatorBearer)
            .send({ service_id: serviceId, user_id: client.id, days: 1, reason: 'Rude to the staff' });

        const [, second] = await missTwice();

        const [row] = (await suspensions()).body.data as Record<string, unknown>[];
        expect(row).toMatchObject({ kind: 'manual', reason: 'Rude to the staff', booking_ids: [] });
        expect(row!['suspended_by']).not.toBeNull();
        const until = new Date(row!['until'] as string).getTime();
        expect(Math.abs(until - (Date.now() + 7 * DAY_MS))).toBeLessThan(60_000);

        expect((await mark(second!, 'completed')).status).toBe(200);
        expect((await suspensions()).body.data).toHaveLength(1);
    });

    it('drops the client from the waitlist of the service', async () => {
        const other = await fx.client();
        const entry = {
            service_id: new Types.ObjectId(serviceId),
            organization_id: new Types.ObjectId(organization.id),
            option_id: option.id,
            slot_id: option.slot_id,
            slot_time: '10:00',
            status: 'waiting',
        };
        await fx.collection('WaitlistEntry').insertMany([
            { ...entry, id: randomUUID(), user_id: new Types.ObjectId(client.id) },
            { ...entry, id: randomUUID(), user_id: new Types.ObjectId(other.id) },
        ]);

        await missTwice();

        const left = await fx.collection<{ user_id: Types.ObjectId }>('WaitlistEntry').find().lean();
        expect(left.map((row) => row.user_id.toHexString())).toEqual([other.id]);
    });

    it('validates the manual suspension and keeps it inside the organization', async () => {
        const post = (body: Record<string, unknown>, bearer = operatorBearer) =>
            t.http.post(`${t.prefix}/suspensions`).set('Authorization', bearer).send(body);

        expectError(
            await post({ service_id: serviceId, user_id: client.id, phone: client.phone, reason: 'x' }),
            400,
            'VALIDATION_ERROR',
        );
        expectError(await post({ service_id: serviceId, user_id: client.id }), 400, 'VALIDATION_ERROR');
        expectError(
            await post({ service_id: serviceId, phone: '4915299999999', reason: 'x' }),
            404,
            'USER_NOT_FOUND',
        );

        const staff = await fx.user({ role: 'common-admin', phone: '4915290008888', organization_ids: [] });
        expectError(
            await post({ service_id: serviceId, user_id: staff.id, reason: 'x' }),
            422,
            'CLIENT_ACCOUNT_REQUIRED',
        );

        const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));
        expectError(
            await post({ service_id: serviceId, user_id: client.id, reason: 'x' }, foreign),
            404,
            'SERVICE_NOT_FOUND',
        );
        expectError(
            await post({ service_id: serviceId, user_id: client.id, reason: 'x' }, clientBearer),
            403,
        );

        const created = await post({ service_id: serviceId, user_id: client.id, reason: 'x' });
        expect((await suspensions('', foreign)).body.data).toEqual([]);
        expectError(
            await t.http
                .delete(`${t.prefix}/suspensions/${created.body.data.id as string}`)
                .set('Authorization', foreign),
            404,
            'SUSPENSION_NOT_FOUND',
        );
        expectError(
            await t.http
                .get(`${t.prefix}/suspensions/${created.body.data.id as string}`)
                .set('Authorization', foreign),
            404,
            'SUSPENSION_NOT_FOUND',
        );
        expectError(await suspensions('', clientBearer), 403);
    });

    describe('late cancellation', () => {
        const usePolicy = (overrides: Record<string, number | string | null>) =>
            fx
                .collection('Service')
                .updateOne(
                    { _id: new Types.ObjectId(serviceId) },
                    { $set: { booking_policy: policy(overrides) } },
                );

        const bookAndCancel = async (bearer = clientBearer): Promise<string> => {
            const created = await book();
            expect(created.status).toBe(201);
            const id = created.body.data.booking_id as string;

            const cancelled = await t.http.delete(`${t.prefix}/bookings/${id}`).set('Authorization', bearer);
            expect(cancelled.status).toBe(204);

            return id;
        };

        const lateFlag = async (id: string) =>
            (await t.http.get(`${t.prefix}/bookings/${id}`).set('Authorization', operatorBearer)).body.data;

        it('counts a cancellation after the deadline as a no-show', async () => {
            await usePolicy({ cancel_deadline_minutes: 48 * 60, late_cancel: 'no_show' });

            const first = await bookAndCancel();
            expect(await lateFlag(first)).toMatchObject({ status: 'cancelled', late_cancel: true });
            expect((await suspensions()).body.data).toEqual([]);

            const second = await bookAndCancel();
            const listed = await suspensions();
            expect(listed.body.data).toHaveLength(1);
            expect(listed.body.data[0]).toMatchObject({ kind: 'no_show', active: true });
            expect([...listed.body.data[0].booking_ids].sort()).toEqual([first, second].sort());
            expectError(await book(), 422, 'BOOKING_SUSPENDED');

            const event = await fx
                .collection<{ payload: Record<string, unknown> }>('OutboxEvent')
                .findOne({ type: 'booking.cancelled', 'payload.booking_id': first })
                .lean();
            expect(event?.payload).toMatchObject({ cancelled_by: 'owner', late_cancel: true });
        });

        it('mixes late cancellations with no-shows in one counter', async () => {
            await usePolicy({ cancel_deadline_minutes: 48 * 60, late_cancel: 'no_show' });

            const { id: missed } = await seedBooking();
            expect((await mark(missed, 'no_show')).status).toBe(200);
            const late = await bookAndCancel();

            const [row] = (await suspensions()).body.data as { booking_ids: string[] }[];
            expect([...row!.booking_ids].sort()).toEqual([missed, late].sort());
        });

        it('does not count a cancellation in time or one by staff', async () => {
            await usePolicy({ cancel_deadline_minutes: 0, late_cancel: 'no_show' });
            const early = await bookAndCancel();
            expect(await lateFlag(early)).toMatchObject({ late_cancel: false });

            await usePolicy({ cancel_deadline_minutes: 48 * 60, late_cancel: 'no_show' });
            const byStaff = await bookAndCancel(operatorBearer);
            expect(await lateFlag(byStaff)).toMatchObject({ late_cancel: false });
            await bookAndCancel(operatorBearer);

            expect((await suspensions()).body.data).toEqual([]);
        });

        it('still refuses a late cancellation under the forbid policy', async () => {
            await usePolicy({ cancel_deadline_minutes: 48 * 60, late_cancel: 'forbid' });
            const created = await book();

            expectError(
                await t.http
                    .delete(`${t.prefix}/bookings/${created.body.data.booking_id as string}`)
                    .set('Authorization', clientBearer),
                422,
                'BOOKING_CANCEL_DEADLINE_PASSED',
            );
        });

        it('refuses a cancellation once the booking has started, even under the no_show policy', async () => {
            await usePolicy({ cancel_deadline_minutes: 48 * 60, late_cancel: 'no_show' });
            const created = await book();
            const id = created.body.data.booking_id as string;
            await fx
                .collection('Booking')
                .updateOne({ id }, { $set: { starts_at: new Date(Date.now() - 60 * 60_000) } });

            expectError(
                await t.http.delete(`${t.prefix}/bookings/${id}`).set('Authorization', clientBearer),
                422,
                'BOOKING_CANCEL_DEADLINE_PASSED',
            );
            expect(await lateFlag(id)).toMatchObject({ status: 'confirmed', late_cancel: false });
            expect((await suspensions()).body.data).toEqual([]);
        });

        it('keeps refusing a late reschedule under the no_show policy', async () => {
            await usePolicy({ cancel_deadline_minutes: 48 * 60, late_cancel: 'no_show' });
            const created = await book();

            expectError(
                await t.http
                    .post(`${t.prefix}/bookings/${created.body.data.booking_id as string}/reschedule`)
                    .set('Authorization', clientBearer)
                    .send({ slot_id: option.slot_id, time: '11:00' }),
                422,
                'BOOKING_CANCEL_DEADLINE_PASSED',
            );
        });
    });

    it('refuses a policy that sets the limit without the suspension length', async () => {
        const admin = await fx.bearer(await fx.admin([organization.id]));
        const res = await t.http
            .patch(`${t.prefix}/services/${serviceId}`)
            .set('Authorization', admin)
            .send({ booking_policy: { no_show_limit: 3 } });

        expectError(res, 400, 'VALIDATION_ERROR');
    });
});
