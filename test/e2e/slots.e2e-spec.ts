import { randomUUID } from 'node:crypto';

import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('service options and slots (e2e)', () => {
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

    const optionBody = () => ({
        label: 'Booking',
        service_type: 'service_apply' as const,
        slots: [],
    });

    it('adds, patches and removes an option without touching its neighbours', async () => {
        const service = await fx.service(organization.id, { options: [] });
        const first = await t.http
            .post(`${t.prefix}/services/${service.id}/options`)
            .set('Authorization', bearer)
            .send(optionBody());
        expect(first.status).toBe(201);
        const second = await t.http
            .post(`${t.prefix}/services/${service.id}/options`)
            .set('Authorization', bearer)
            .send({ ...optionBody(), label: 'Second' });
        expect(second.body.data.options).toHaveLength(2);

        const optionId = second.body.data.options[0].id as string;
        const patched = await t.http
            .patch(`${t.prefix}/services/${service.id}/options/${optionId}`)
            .set('Authorization', bearer)
            .send({ label: 'Renamed', enabled: false });
        expect(patched.status).toBe(200);
        expect(patched.body.data.options[0]).toMatchObject({ label: 'Renamed', enabled: false });
        expect(patched.body.data.options[1]).toMatchObject({ label: 'Second' });

        expectError(
            await t.http
                .patch(`${t.prefix}/services/${service.id}/options/${randomUUID()}`)
                .set('Authorization', bearer)
                .send({ label: 'x' }),
            404,
            'OPTION_NOT_FOUND',
        );

        const removed = await t.http
            .delete(`${t.prefix}/services/${service.id}/options/${optionId}`)
            .set('Authorization', bearer);
        expect(removed.status).toBe(204);
        const after = await t.http.get(`${t.prefix}/services/${service.id}`);
        expect(after.body.data.options).toHaveLength(1);
        expect(after.body.data.options[0].label).toBe('Second');
    });

    it('adds a slot, edits its times, and refuses to drop a time that still holds a booking', async () => {
        const option = fx.bookableOption(2, '10:00');
        const service = await fx.service(organization.id, { options: [option] });
        const client = await fx.client();
        await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', await fx.bearer(client))
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });

        const added = await t.http
            .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots`)
            .set('Authorization', bearer)
            .send({ child_type: 'apply', label: 'Walk-in', value: { limit: 5 } });
        expect(added.status).toBe(201);
        expect(added.body.data.options[0].slots).toHaveLength(2);

        const base = `${t.prefix}/services/${service.id}/options/${option.id}/slots/${option.slot_id}`;
        const extended = await t.http
            .patch(base)
            .set('Authorization', bearer)
            .send({
                label: 'Morning',
                time: [
                    { time: '10:00', limit: 4 },
                    { time: '11:00', limit: 1 },
                ],
            });
        expect(extended.status).toBe(200);
        const times = extended.body.data.options[0].slots[0].value.time as {
            time: string;
            limit: number;
            booked_count: number;
        }[];
        expect(extended.body.data.options[0].slots[0].label).toBe('Morning');
        expect(times.map((entry) => entry.time)).toEqual(['10:00', '11:00']);
        expect(times[0]).toMatchObject({ limit: 4, booked_count: 1 });

        expectError(
            await t.http
                .patch(base)
                .set('Authorization', bearer)
                .send({ time: [{ time: '11:00' }] }),
            409,
            'SLOT_TIME_BOOKED',
        );

        const dropped = await t.http
            .patch(base)
            .set('Authorization', bearer)
            .send({ time: [{ time: '10:00', limit: 4 }] });
        expect(dropped.status).toBe(200);
        expect(dropped.body.data.options[0].slots[0].value.time).toHaveLength(1);
    });

    it('refuses to remove a slot or an option that still holds bookings, and rejects wrong field types', async () => {
        const option = fx.bookableOption(2, '10:00');
        const service = await fx.service(organization.id, { options: [option] });
        const client = await fx.client();
        const booked = await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', await fx.bearer(client))
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        expect(booked.status).toBe(201);

        const slotPath = `${t.prefix}/services/${service.id}/options/${option.id}/slots/${option.slot_id}`;
        expectError(await t.http.delete(slotPath).set('Authorization', bearer), 409, 'SLOT_HAS_BOOKINGS');
        expectError(
            await t.http
                .delete(`${t.prefix}/services/${service.id}/options/${option.id}`)
                .set('Authorization', bearer),
            409,
            'OPTION_HAS_BOOKINGS',
        );
        expectError(
            await t.http.patch(slotPath).set('Authorization', bearer).send({ limit: 3 }),
            422,
            'SLOT_NOT_LIMITED',
        );

        await t.http
            .delete(`${t.prefix}/services/${service.id}/bookings/${booked.body.data.booking_id as string}`)
            .set('Authorization', bearer);
        expect((await t.http.delete(slotPath).set('Authorization', bearer)).status).toBe(204);
    });

    it('replaces the recurrence of one option and leaves the rest of the service alone', async () => {
        const option = fx.bookableOption(2);
        const service = await fx.service(organization.id, { options: [option] });
        const path = `${t.prefix}/services/${service.id}/options/${option.id}/recurrence`;
        const set = await t.http
            .put(path)
            .set('Authorization', bearer)
            .send({ recurrent_dates: [{ day: 'monday', time: [{ time: '09:00', limit: 2 }] }] });
        expect(set.status).toBe(200);
        expect(set.body.data.options[0].recurrent_dates).toEqual([
            { day: 'monday', time: [{ time: '09:00', limit: 2 }], limit: null },
        ]);
        expect(set.body.data.options[0].slots).toHaveLength(1);

        const cleared = await t.http.put(path).set('Authorization', bearer).send({ recurrent_dates: null });
        expect(cleared.body.data.options[0].recurrent_dates).toBeUndefined();
    });

    describe('bulk operations', () => {
        const dateOnly = (offsetDays: number): string => {
            const now = new Date();
            const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);

            return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        };

        const day = (date: string, times: string[], id = randomUUID()) => ({
            id,
            label: 'Day',
            child_type: 'date_time' as const,
            value: { date, time: times.map((time) => ({ time, limit: 1, booked_count: 0 })) },
        });

        const optionWith = (slots: ReturnType<typeof day>[], id = randomUUID()) => ({
            id,
            label: 'Booking',
            service_type: 'service_apply' as const,
            enabled: true,
            slots,
        });

        const book = async (serviceId: string, body: Record<string, unknown>, client: FixtureUser) => {
            const res = await t.http
                .post(`${t.prefix}/services/${serviceId}/bookings`)
                .set('Authorization', await fx.bearer(client))
                .send(body);
            expect(res.status).toBe(201);

            return res.body.data.booking_id as string;
        };

        it('cancels every booking of a closed slot, drops its waiting list and tells the clients', async () => {
            const slot = day(dateOnly(1), ['10:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            const holder = await fx.client({ phone: '4915291111111' });
            const waiting = await fx.client({ phone: '4915292222222' });
            const target = { option_id: option.id, slot_id: slot.id, time: '10:00' };
            const bookingId = await book(service.id, target, holder);
            const queued = await t.http
                .post(`${t.prefix}/services/${service.id}/waitlist`)
                .set('Authorization', await fx.bearer(waiting))
                .send(target);
            expect(queued.status).toBe(201);

            const closed = await t.http
                .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/cancel`)
                .set('Authorization', bearer)
                .send({ reason: 'The cabinet is closed', remove: true });
            expect(closed.status).toBe(200);
            expect(closed.body.data).toMatchObject({
                cancelled: 1,
                waitlist_dropped: 1,
                notifications_queued: 1,
                removed: true,
                time: null,
            });

            const booking = await t.http
                .get(`${t.prefix}/bookings/${bookingId}`)
                .set('Authorization', bearer);
            expect(booking.body.data).toMatchObject({ status: 'cancelled' });
            const after = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(after.body.data.options[0].slots).toHaveLength(0);
            expect(await fx.collection('WaitlistEntry').countDocuments({})).toBe(0);

            await waitFor(
                async () => (await fx.collection('Sms').countDocuments({ purpose: 'cancellation' })) === 1,
            );
            const sms = await fx
                .collection<{ phone: string; text: string }>('Sms')
                .findOne({ purpose: 'cancellation' })
                .lean();
            expect(sms!.phone).toBe('4915291111111');
            expect(await fx.collection('Sms').countDocuments({ purpose: 'waitlist' })).toBe(0);
            const event = await fx
                .collection<{ payload: Record<string, unknown> }>('OutboxEvent')
                .findOne({ type: 'booking.cancelled' })
                .lean();
            expect(event!.payload).toMatchObject({
                booking_id: bookingId,
                bulk: true,
                cancelled_by: 'admin',
                reason: 'The cabinet is closed',
            });
        });

        it('closes a single time of a slot and leaves the neighbouring one booked', async () => {
            const slot = day(dateOnly(1), ['10:00', '11:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            const morning = await fx.client();
            const noon = await fx.client();
            await book(service.id, { option_id: option.id, slot_id: slot.id, time: '10:00' }, morning);
            await book(service.id, { option_id: option.id, slot_id: slot.id, time: '11:00' }, noon);

            const closed = await t.http
                .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/cancel`)
                .set('Authorization', bearer)
                .send({ time: '10:00', remove: true, notify: false });
            expect(closed.status).toBe(200);
            expect(closed.body.data).toMatchObject({
                cancelled: 1,
                notifications_queued: 0,
                removed: true,
                time: '10:00',
            });

            const after = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(after.body.data.options[0].slots[0].value.time).toEqual([
                { time: '11:00', limit: 1, booked_count: 1, bookings: [{ status: 'reserved' }] },
            ]);
            expect(await fx.collection('Sms').countDocuments({ purpose: 'cancellation' })).toBe(0);
        });

        it('moves a whole day with its bookings, its times and its waiting list', async () => {
            const slot = day(dateOnly(1), ['10:00', '11:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            const morning = await fx.client({ phone: '4915293333333' });
            const noon = await fx.client();
            const later = await fx.client();
            const first = await book(
                service.id,
                { option_id: option.id, slot_id: slot.id, time: '10:00' },
                morning,
            );
            await book(service.id, { option_id: option.id, slot_id: slot.id, time: '11:00' }, noon);
            const queued = await t.http
                .post(`${t.prefix}/services/${service.id}/waitlist`)
                .set('Authorization', await fx.bearer(later))
                .send({ option_id: option.id, slot_id: slot.id, time: '10:00' });
            expect(queued.status).toBe(201);

            await fx
                .collection('Booking')
                .updateOne({ id: first }, { $set: { reminder_sent_at: new Date() } });

            const moved = await t.http
                .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/move`)
                .set('Authorization', bearer)
                .send({ date: dateOnly(3), shift_minutes: 60, reason: 'The cabinet moved' });
            expect(moved.status).toBe(200);
            expect(moved.body.data).toMatchObject({
                date: dateOnly(3),
                previous_date: dateOnly(1),
                moved: 2,
                notifications_queued: 2,
            });

            const after = await t.http.get(`${t.prefix}/services/${service.id}`);
            const stored = after.body.data.options[0].slots[0] as {
                value: { date: string; time: { time: string; booked_count: number }[] };
            };
            expect(stored.value.date).toBe(dateOnly(3));
            expect(stored.value.time.map((entry) => [entry.time, entry.booked_count])).toEqual([
                ['11:00', 1],
                ['12:00', 1],
            ]);

            const booking = await t.http.get(`${t.prefix}/bookings/${first}`).set('Authorization', bearer);
            expect(booking.body.data).toMatchObject({ date: dateOnly(3), time: '11:00' });
            const stale = await fx
                .collection<{ reminder_sent_at: Date | null }>('Booking')
                .findOne({ id: first })
                .lean();
            expect(stale!.reminder_sent_at).toBeNull();
            const waitlist = await fx
                .collection<{ slot_date: string; slot_time: string }>('WaitlistEntry')
                .findOne({})
                .lean();
            expect(waitlist).toMatchObject({ slot_date: dateOnly(3), slot_time: '11:00' });

            const history = await t.http
                .get(`${t.prefix}/services/${service.id}/history`)
                .set('Authorization', bearer);
            expect(history.body.data[0]).toMatchObject({ action: 'slot.update' });

            await waitFor(
                async () => (await fx.collection('Sms').countDocuments({ purpose: 'reschedule' })) === 2,
            );
            expect(
                await fx.collection('Sms').countDocuments({ purpose: 'reschedule', phone: '4915293333333' }),
            ).toBe(1);
        });

        it('shifts a day onto its own times, for a client who holds two of them and waits for a third', async () => {
            const slot = day(dateOnly(1), ['10:00', '11:00', '12:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            const both = await fx.client();
            const other = await fx.client();
            await book(service.id, { option_id: option.id, slot_id: slot.id, time: '10:00' }, both);
            await book(service.id, { option_id: option.id, slot_id: slot.id, time: '11:00' }, both);
            await book(service.id, { option_id: option.id, slot_id: slot.id, time: '12:00' }, other);
            const waitlistBearer = await fx.bearer(both);

            for (const time of ['12:00']) {
                const joined = await t.http
                    .post(`${t.prefix}/services/${service.id}/waitlist`)
                    .set('Authorization', waitlistBearer)
                    .send({ option_id: option.id, slot_id: slot.id, time });
                expect(joined.status).toBe(201);
            }

            const moved = await t.http
                .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/move`)
                .set('Authorization', bearer)
                .send({ date: dateOnly(3), shift_minutes: 60 });
            expect(moved.status).toBe(200);
            expect(moved.body.data).toMatchObject({ moved: 3 });

            const after = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(
                (after.body.data.options[0].slots[0].value.time as { time: string }[]).map(
                    (entry) => entry.time,
                ),
            ).toEqual(['11:00', '12:00', '13:00']);
            const times = await fx.collection<{ slot_time: string }>('Booking').find({ active: true }).lean();
            expect(times.map((row) => row.slot_time).sort()).toEqual(['11:00', '12:00', '13:00']);
            const waiting = await fx.collection<{ slot_time: string }>('WaitlistEntry').findOne({}).lean();
            expect(waiting!.slot_time).toBe('13:00');
        });

        it('offers the freed places to the waiting list when the slot itself stays open', async () => {
            const slot = day(dateOnly(1), ['10:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            const holder = await fx.client({ phone: '4915291111111' });
            const waiting = await fx.client({ phone: '4915292222222' });
            const target = { option_id: option.id, slot_id: slot.id, time: '10:00' };
            await book(service.id, target, holder);
            const queued = await t.http
                .post(`${t.prefix}/services/${service.id}/waitlist`)
                .set('Authorization', await fx.bearer(waiting))
                .send(target);
            expect(queued.status).toBe(201);

            const closed = await t.http
                .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/cancel`)
                .set('Authorization', bearer)
                .send({ reason: 'The doctor is ill' });
            expect(closed.status).toBe(200);
            expect(closed.body.data).toMatchObject({
                cancelled: 1,
                waitlist_dropped: 0,
                removed: false,
            });

            const after = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(after.body.data.options[0].slots[0].value.time[0]).toMatchObject({ booked_count: 0 });
            await waitFor(
                async () =>
                    (await fx
                        .collection('Sms')
                        .countDocuments({ purpose: 'waitlist', phone: '4915292222222' })) === 1,
            );
            const entry = await fx.collection<{ status: string }>('WaitlistEntry').findOne({}).lean();
            expect(entry!.status).toBe('notified');
        });

        it('replays a move that carries the same Idempotency-Key instead of shifting twice', async () => {
            const slot = day(dateOnly(1), ['10:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            await book(
                service.id,
                { option_id: option.id, slot_id: slot.id, time: '10:00' },
                await fx.client(),
            );
            const path = `${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/move`;
            const body = { date: dateOnly(3), shift_minutes: 60 };

            const first = await t.http
                .post(path)
                .set('Authorization', bearer)
                .set('Idempotency-Key', 'move-key-1')
                .send(body);
            expect(first.status).toBe(200);
            const replay = await t.http
                .post(path)
                .set('Authorization', bearer)
                .set('Idempotency-Key', 'move-key-1')
                .send(body);
            expect(replay.status).toBe(200);
            expect(replay.headers['idempotency-replayed']).toBe('true');
            expect(replay.body.data).toEqual(first.body.data);

            const after = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(after.body.data.options[0].slots[0].value.time[0].time).toBe('11:00');
        });

        it('treats a move that changes neither the date nor the times as nothing to do', async () => {
            const slot = day(dateOnly(1), ['10:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            await book(
                service.id,
                { option_id: option.id, slot_id: slot.id, time: '10:00' },
                await fx.client(),
            );

            const again = await t.http
                .post(`${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}/move`)
                .set('Authorization', bearer)
                .send({ date: dateOnly(1) });
            expect(again.status).toBe(200);
            expect(again.body.data).toMatchObject({ moved: 0, notifications_queued: 0 });
            expect(await fx.collection('OutboxEvent').countDocuments({ type: 'booking.rescheduled' })).toBe(
                0,
            );
            const history = await t.http
                .get(`${t.prefix}/services/${service.id}/history`)
                .set('Authorization', bearer);
            expect(history.body.data).toHaveLength(0);
        });

        it('refuses a move into the past, onto a taken date, out of the day or of an undated slot', async () => {
            const first = day(dateOnly(1), ['10:00']);
            const second = day(dateOnly(2), ['10:00']);
            const apply = {
                id: randomUUID(),
                label: 'Walk-in',
                child_type: 'apply' as const,
                value: { limit: 5, booked_count: 0 },
            };
            const option = optionWith([first, second, apply as unknown as ReturnType<typeof day>]);
            const service = await fx.service(organization.id, { options: [option] });
            const base = `${t.prefix}/services/${service.id}/options/${option.id}/slots`;
            const move = (slotId: string, body: Record<string, unknown>) =>
                t.http.post(`${base}/${slotId}/move`).set('Authorization', bearer).send(body);

            expectError(await move(first.id, { date: dateOnly(-1) }), 422, 'SLOT_EXPIRED');
            expectError(await move(first.id, { date: dateOnly(2) }), 409, 'SLOT_DATE_TAKEN');
            expectError(
                await move(first.id, { date: dateOnly(4), shift_minutes: -1439 }),
                422,
                'SLOT_TIME_OUT_OF_RANGE',
            );
            expectError(await move(apply.id, { date: dateOnly(4) }), 422, 'SLOT_NOT_DATED');
            expectError(await move(randomUUID(), { date: dateOnly(4) }), 404, 'SLOT_NOT_FOUND');
            expectError(
                await t.http
                    .post(`${base}/${apply.id}/cancel`)
                    .set('Authorization', bearer)
                    .send({ time: '10:00' }),
                422,
                'SLOT_NOT_TIMED',
            );
            expectError(
                await t.http
                    .post(`${base}/${first.id}/cancel`)
                    .set('Authorization', bearer)
                    .send({ time: '23:00' }),
                404,
                'SLOT_NOT_FOUND',
            );

            const untouched = await t.http.get(`${t.prefix}/services/${service.id}`);
            expect(untouched.body.data.options[0].slots[0].value.date).toBe(dateOnly(1));
        });

        it('is closed to clients and to admins of another organization', async () => {
            const slot = day(dateOnly(1), ['10:00']);
            const option = optionWith([slot]);
            const service = await fx.service(organization.id, { options: [option] });
            const client = await fx.bearer(await fx.client());
            const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));
            const base = `${t.prefix}/services/${service.id}/options/${option.id}/slots/${slot.id}`;

            for (const [token, status] of [
                [client, 403],
                [foreign, 404],
            ] as const) {
                expect(
                    (await t.http.post(`${base}/cancel`).set('Authorization', token).send({})).status,
                ).toBe(status);
                expect(
                    (
                        await t.http
                            .post(`${base}/move`)
                            .set('Authorization', token)
                            .send({ date: dateOnly(4) })
                    ).status,
                ).toBe(status);
            }
        });
    });

    it('is closed to clients and to admins of another organization', async () => {
        const option = fx.bookableOption(2);
        const service = await fx.service(organization.id, { options: [option] });
        const client = await fx.bearer(await fx.client());
        const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));

        for (const [token, status] of [
            [client, 403],
            [foreign, 404],
        ] as const) {
            const res = await t.http
                .post(`${t.prefix}/services/${service.id}/options`)
                .set('Authorization', token)
                .send(optionBody());
            expect(res.status).toBe(status);
        }
    });
});
