import { randomUUID } from 'node:crypto';

import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

/** Options and slots as sub-resources: one option or slot changes without resending the array. */
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
        const citizen = await fx.citizen();
        await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', await fx.bearer(citizen))
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
        const citizen = await fx.citizen();
        const booked = await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', await fx.bearer(citizen))
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
            { day: 'monday', time: [{ time: '09:00', limit: 2 }] },
        ]);
        expect(set.body.data.options[0].slots).toHaveLength(1);

        const cleared = await t.http.put(path).set('Authorization', bearer).send({ recurrent_dates: null });
        expect(cleared.body.data.options[0].recurrent_dates).toBeUndefined();
    });

    it('is closed to citizens and to admins of another organization', async () => {
        const option = fx.bookableOption(2);
        const service = await fx.service(organization.id, { options: [option] });
        const citizen = await fx.bearer(await fx.citizen());
        const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));

        for (const [token, status] of [
            [citizen, 403],
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
