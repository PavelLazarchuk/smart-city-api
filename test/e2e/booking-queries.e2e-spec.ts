import { randomUUID } from 'node:crypto';

import { type OptionTree } from '../../src/modules/services/slot.logic';
import { expectError } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

type Status = 'pending' | 'confirmed' | 'completed' | 'no_show' | 'cancelled';

describe('booking transitions, filters and statistics (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let adminBearer: string;
    let client: FixtureUser;
    let clientBearer: string;
    let option: OptionTree & { slot_id: string; apply_id: string };
    let serviceId: string;

    const twoSlots = (): OptionTree & { slot_id: string; apply_id: string } => {
        const slotId = randomUUID();
        const applyId = randomUUID();

        return {
            id: randomUUID(),
            label: 'Booking',
            service_type: 'service_apply',
            enabled: true,
            slots: [
                {
                    id: slotId,
                    label: 'Date',
                    child_type: 'date_time',
                    value: {
                        date: dateOnly(3),
                        time: [
                            { time: '10:00', limit: 5, booked_count: 0 },
                            { time: '11:00', limit: 5, booked_count: 0 },
                        ],
                    },
                },
                { id: applyId, label: 'Apply', child_type: 'apply', value: { limit: null, booked_count: 0 } },
            ],
            slot_id: slotId,
            apply_id: applyId,
        };
    };

    const seed = (status: Status = 'confirmed', overrides: Partial<{ user_id: string; time: string }> = {}) =>
        fx.booking({
            service_id: serviceId,
            organization_id: organization.id,
            option_id: option.id,
            slot_id: option.slot_id,
            user_id: overrides.user_id ?? client.id,
            time: overrides.time ?? '10:00',
            slot_date: dateOnly(3),
            status,
        });

    const setStatus = (id: string, status: string, bearer = adminBearer) =>
        t.http.patch(`${t.prefix}/bookings/${id}/status`).set('Authorization', bearer).send({ status });

    const get = (path: string, bearer = adminBearer) =>
        t.http.get(`${t.prefix}${path}`).set('Authorization', bearer);

    const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((row) => row.id).sort();

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        adminBearer = await fx.bearer(await fx.admin([organization.id]));
        client = await fx.client({ name: 'Anna' });
        clientBearer = await fx.bearer(client);
        option = twoSlots();
        serviceId = (await fx.service(organization.id, { options: [option] })).id;
    });

    describe('status transitions', () => {
        it.each([
            ['pending', 'completed'],
            ['pending', 'no_show'],
            ['completed', 'confirmed'],
            ['completed', 'cancelled'],
            ['no_show', 'cancelled'],
            ['cancelled', 'confirmed'],
            ['cancelled', 'completed'],
        ] as const)('refuses %s → %s', async (from, to) => {
            const { id } = await seed(from);

            expectError(await setStatus(id, to), 422, 'BOOKING_STATUS_TRANSITION');
        });

        it('corrects a completed booking to a no-show and back', async () => {
            const { id } = await seed('completed');

            expect((await setStatus(id, 'no_show')).body.data.status).toBe('no_show');
            expect((await setStatus(id, 'completed')).body.data.status).toBe('completed');
        });

        it('cancels through the status route and frees the place', async () => {
            const { id } = await seed('confirmed');
            const booked = async () =>
                (await fx.storedSlot(serviceId, option.slot_id)).value.time![0]!.booked_count;
            expect(await booked()).toBe(1);

            const res = await setStatus(id, 'cancelled');
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('cancelled');
            expect(await booked()).toBe(0);
        });

        it('hides the booking from staff of another organization and from its owner', async () => {
            const { id } = await seed('confirmed');
            const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));

            expectError(await setStatus(id, 'completed', foreign), 404, 'BOOKING_NOT_FOUND');
            expectError(await setStatus(id, 'completed', clientBearer), 403);
            expectError(await setStatus(randomUUID(), 'completed'), 404, 'BOOKING_NOT_FOUND');
        });
    });

    describe('confirmation', () => {
        it('confirms a pending booking once and refuses anything else', async () => {
            const { id } = await seed('pending');
            const confirm = (bearer = adminBearer) =>
                t.http.post(`${t.prefix}/bookings/${id}/confirm`).set('Authorization', bearer);

            expectError(await confirm(await fx.bearer(await fx.client())), 404, 'BOOKING_NOT_FOUND');
            const confirmed = await confirm();
            expect(confirmed.status).toBe(200);
            expect(confirmed.body.data.status).toBe('confirmed');
            expectError(await confirm(), 422, 'BOOKING_STATUS_TRANSITION');

            const events = await fx
                .collection<{ payload: Record<string, unknown> }>('OutboxEvent')
                .find({ type: 'booking.status_changed' })
                .lean();
            expect(events.map((event) => event.payload['previous_status'])).toEqual(['pending']);
        });
    });

    describe('cancellation guards', () => {
        it('answers 404 under another service, 403 to a stranger and 422 once cancelled', async () => {
            const { id } = await seed('confirmed');
            const other = (await fx.service(organization.id)).id;
            const stranger = await fx.bearer(await fx.client());

            expectError(
                await t.http
                    .delete(`${t.prefix}/services/${other}/bookings/${id}`)
                    .set('Authorization', clientBearer),
                404,
                'BOOKING_NOT_FOUND',
            );
            expectError(
                await t.http.delete(`${t.prefix}/bookings/${id}`).set('Authorization', stranger),
                403,
                'FORBIDDEN',
            );
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/services/${serviceId}/bookings/${id}`)
                        .set('Authorization', clientBearer)
                ).status,
            ).toBe(204);
            expectError(
                await t.http.delete(`${t.prefix}/bookings/${id}`).set('Authorization', clientBearer),
                422,
                'BOOKING_NOT_ACTIVE',
            );
        });

        it('records who cancelled', async () => {
            const own = await seed('confirmed');
            const byStaff = await seed('confirmed', { time: '11:00' });

            await t.http.delete(`${t.prefix}/bookings/${own.id}`).set('Authorization', clientBearer);
            await t.http.delete(`${t.prefix}/bookings/${byStaff.id}`).set('Authorization', adminBearer);

            const events = await fx
                .collection<{ payload: Record<string, unknown> }>('OutboxEvent')
                .find({ type: 'booking.cancelled' })
                .lean();
            expect(events.map((event) => event.payload['cancelled_by']).sort()).toEqual(['admin', 'owner']);
        });
    });

    describe('reschedule guards', () => {
        const reschedule = (id: string, body: Record<string, unknown>, bearer = clientBearer) =>
            t.http.post(`${t.prefix}/bookings/${id}/reschedule`).set('Authorization', bearer).send(body);

        it('answers 404, 403 and 422 for an unknown, foreign and finished booking', async () => {
            const finished = await seed('completed');
            const own = await seed('confirmed');

            expectError(await reschedule(randomUUID(), { slot_id: option.slot_id, time: '11:00' }), 404);
            expectError(
                await reschedule(
                    own.id,
                    { slot_id: option.slot_id, time: '11:00' },
                    await fx.bearer(await fx.client()),
                ),
                403,
                'FORBIDDEN',
            );
            expectError(
                await reschedule(finished.id, { slot_id: option.slot_id, time: '11:00' }),
                422,
                'BOOKING_NOT_ACTIVE',
            );
            expectError(
                await reschedule(own.id, { slot_id: option.slot_id, time: '10:00' }),
                409,
                'BOOKING_ALREADY_EXISTS',
            );
        });

        it('lets staff move a booking past the cancellation deadline that binds the client', async () => {
            await fx.collection('Service').updateOne(
                { label: { $exists: true } },
                {
                    $set: {
                        booking_policy: {
                            max_active_per_user: null,
                            lead_time_minutes: null,
                            max_advance_days: null,
                            cancel_deadline_minutes: 10 * 24 * 60,
                            late_cancel: 'forbid',
                            requires_confirmation: false,
                            no_show_limit: null,
                            no_show_window_days: null,
                            no_show_suspension_days: null,
                        },
                    },
                },
            );
            const created = await t.http
                .post(`${t.prefix}/services/${serviceId}/bookings`)
                .set('Authorization', adminBearer)
                .send({
                    option_id: option.id,
                    slot_id: option.slot_id,
                    time: '10:00',
                    on_behalf: { phone: client.phone, name: 'Anna' },
                });
            const id = created.body.data.booking_id as string;

            expectError(await reschedule(id, { slot_id: option.slot_id, time: '11:00' }), 422);
            const moved = await reschedule(id, { slot_id: option.slot_id, time: '11:00' }, adminBearer);
            expect(moved.status).toBe(200);
            expect(moved.body.data.time).toBe('11:00');
            expect(moved.body.data.cancel_deadline_at).toEqual(expect.any(String));
        });

        it('moves a timed booking to an undated slot of the same option', async () => {
            const { id } = await seed('confirmed');

            const moved = await reschedule(id, { slot_id: option.apply_id });
            expect(moved.status).toBe(200);
            expect(moved.body.data).toMatchObject({ slot_id: option.apply_id, child_type: 'apply' });
            expect(moved.body.data.time).toBeNull();
            expect((await fx.storedSlot(serviceId, option.slot_id)).value.time![0]!.booked_count).toBe(0);
            expect((await fx.storedSlot(serviceId, option.apply_id)).value.booked_count).toBe(1);
        });
    });

    describe('lists', () => {
        it('filters the organization list by status, slot, type, client and dates', async () => {
            const other = await fx.client();
            const active = await seed('confirmed');
            const pending = await seed('pending', { time: '11:00' });
            const done = await seed('completed', { user_id: other.id });
            const applied = await fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.apply_id,
                user_id: other.id,
            });

            expect(ids(await get('/bookings'))).toEqual([active.id, pending.id, applied.id].sort());
            expect(ids(await get('/bookings?status=all'))).toHaveLength(4);
            expect(ids(await get('/bookings?status=completed'))).toEqual([done.id]);
            expect(ids(await get('/bookings?status=pending'))).toEqual([pending.id]);
            expect(ids(await get(`/bookings?user_id=${other.id}&status=all`))).toEqual(
                [done.id, applied.id].sort(),
            );
            expect(ids(await get(`/bookings?slot_id=${option.apply_id}`))).toEqual([applied.id]);
            expect(ids(await get(`/bookings?option_id=${option.id}&child_type=apply`))).toEqual([applied.id]);
            expect(ids(await get(`/bookings?service_id=${serviceId}&date_from=${dateOnly(3)}`))).toEqual(
                [active.id, pending.id].sort(),
            );
            expect(ids(await get(`/bookings?date_to=${dateOnly(2)}`))).toEqual([]);
        });

        it('filters the list of a service by slot and status and answers 404 for a malformed id', async () => {
            const active = await seed('confirmed');
            const cancelled = await seed('cancelled');

            expect(ids(await get(`/services/${serviceId}/bookings?slot_id=${option.slot_id}`))).toEqual([
                active.id,
            ]);
            expect(ids(await get(`/services/${serviceId}/bookings?status=cancelled`))).toEqual([
                cancelled.id,
            ]);
            expect(ids(await get(`/services/${serviceId}/bookings?option_id=${randomUUID()}`))).toEqual([]);
            expectError(await get('/services/not-an-id/bookings'), 404);
        });

        it('filters the own list of a client by status and day', async () => {
            const active = await seed('confirmed');
            const done = await seed('completed');
            await seed('confirmed', { user_id: (await fx.client()).id, time: '11:00' });

            expect(ids(await get('/me/bookings', clientBearer))).toEqual([active.id]);
            expect(ids(await get('/me/bookings?status=all', clientBearer))).toEqual(
                [active.id, done.id].sort(),
            );
            expect(ids(await get(`/me/bookings?status=all&date_from=${dateOnly(4)}`, clientBearer))).toEqual(
                [],
            );
        });

        it('lists the waitlist of a service by slot', async () => {
            const full = twoSlots();
            full.slots[0]!.value = {
                date: dateOnly(3),
                time: [{ time: '10:00', limit: 1, booked_count: 0 }],
            };
            const fullService = (await fx.service(organization.id, { options: [full] })).id;
            await t.http
                .post(`${t.prefix}/services/${fullService}/bookings`)
                .set('Authorization', await fx.bearer(await fx.client()))
                .send({ option_id: full.id, slot_id: full.slot_id, time: '10:00' });
            const joined = await t.http
                .post(`${t.prefix}/services/${fullService}/waitlist`)
                .set('Authorization', clientBearer)
                .send({ option_id: full.id, slot_id: full.slot_id, time: '10:00' });
            expect(joined.status).toBe(201);

            expect(ids(await get(`/services/${fullService}/waitlist?slot_id=${full.slot_id}`))).toEqual([
                joined.body.data.id,
            ]);
            expect(ids(await get(`/services/${fullService}/waitlist?option_id=${randomUUID()}`))).toEqual([]);
            expectError(await get('/services/not-an-id/waitlist'), 404);
        });
    });

    describe('statistics', () => {
        it('counts by service and slot day and answers no rates without outcomes', async () => {
            await seed('confirmed');
            await seed('cancelled');
            await seed('no_show');
            await seed('completed');
            await seed('completed');
            const other = (await fx.service(organization.id)).id;

            const all = await get('/bookings/stats');
            expect(all.body.data).toMatchObject({ total: 5, no_show_rate: 1 / 3, cancellation_rate: 1 / 4 });

            const empty = await get(`/bookings/stats?service_id=${other}`);
            expect(empty.body.data).toMatchObject({ total: 0, no_show_rate: null, cancellation_rate: null });

            expect(
                (await get(`/bookings/stats?date_from=${dateOnly(3)}&date_to=${dateOnly(3)}`)).body.data
                    .total,
            ).toBe(5);
            expect((await get(`/bookings/stats?date_from=${dateOnly(4)}`)).body.data.total).toBe(0);
        });

        it('scopes staff to their organizations and lets a super-admin pick one', async () => {
            await seed('confirmed');
            const otherOrganization = await fx.organization();
            const superBearer = await fx.bearer(await fx.superAdmin());

            expectError(
                await get(`/bookings/stats?organization_id=${otherOrganization.id}`),
                403,
                'FORBIDDEN',
            );
            expect((await get(`/bookings/stats?organization_id=${organization.id}`)).body.data.total).toBe(1);
            expect((await get('/bookings/stats', superBearer)).body.data.total).toBe(1);
            expect(
                (await get(`/bookings/stats?organization_id=${otherOrganization.id}`, superBearer)).body.data
                    .total,
            ).toBe(0);
        });
    });
});
