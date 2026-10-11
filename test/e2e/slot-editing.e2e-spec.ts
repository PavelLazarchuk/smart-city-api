import { randomUUID } from 'node:crypto';

import { type OptionTree } from '../../src/modules/services/slot.logic';
import { expectError } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

interface Ids {
    service: string;
    option: string;
    timed: string;
    dated: string;
    apply: string;
}

describe('slot editing and availability (e2e)', () => {
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

    const catalogue = async (overrides: Record<string, unknown> = {}): Promise<Ids> => {
        const ids = { option: randomUUID(), timed: randomUUID(), dated: randomUUID(), apply: randomUUID() };
        const option: OptionTree = {
            id: ids.option,
            label: 'Main',
            service_type: 'service_apply',
            enabled: true,
            slots: [
                {
                    id: ids.timed,
                    label: 'Timed',
                    child_type: 'date_time',
                    value: {
                        date: dateOnly(2),
                        time: [
                            { time: '09:00', limit: 1, booked_count: 0 },
                            { time: '15:00', limit: 3, booked_count: 0 },
                        ],
                    },
                },
                {
                    id: ids.dated,
                    label: 'Dated',
                    child_type: 'date',
                    value: { date: dateOnly(5), limit: 2, booked_count: 0 },
                },
                {
                    id: ids.apply,
                    label: 'Apply',
                    child_type: 'apply',
                    value: { limit: null, booked_count: 0 },
                },
            ],
        };
        const service = await fx.service(organization.id, { options: [option], ...overrides });

        return { service: service.id, ...ids };
    };

    const slotPath = (ids: Ids, slot: string) =>
        `${t.prefix}/services/${ids.service}/options/${ids.option}/slots/${slot}`;
    const patchSlot = (ids: Ids, slot: string, body: Record<string, unknown>) =>
        t.http.patch(slotPath(ids, slot)).set('Authorization', bearer).send(body);

    describe('slot fields', () => {
        it('accepts only the fields that belong to the slot type', async () => {
            const ids = await catalogue();

            expectError(await patchSlot(ids, ids.apply, { date: dateOnly(3) }), 422, 'SLOT_NOT_DATED');
            expectError(await patchSlot(ids, ids.timed, { from: '08:00' }), 422, 'SLOT_NOT_RANGED');
            expectError(await patchSlot(ids, ids.timed, { limit: 3 }), 422, 'SLOT_NOT_LIMITED');
            expectError(
                await patchSlot(ids, ids.dated, { time: [{ time: '10:00' }] }),
                422,
                'SLOT_NOT_TIMED',
            );
            expectError(await patchSlot(ids, randomUUID(), { label: 'x' }), 404, 'SLOT_NOT_FOUND');
        });

        it('moves a dated slot, changes the limit of an undated one and the limit of one time', async () => {
            const ids = await catalogue();

            const moved = await patchSlot(ids, ids.dated, { date: dateOnly(6), limit: 4 });
            expect(moved.status).toBe(200);
            expect((await fx.storedSlot(ids.service, ids.dated)).value).toMatchObject({
                date: dateOnly(6),
                limit: 4,
            });

            expect((await patchSlot(ids, ids.apply, { limit: 10 })).status).toBe(200);
            expect((await fx.storedSlot(ids.service, ids.apply)).value.limit).toBe(10);

            const limited = await patchSlot(ids, ids.timed, {
                time: [
                    { time: '09:00', limit: 5 },
                    { time: '15:00', limit: 3 },
                ],
            });
            expect(limited.status).toBe(200);
            expect(
                (await fx.storedSlot(ids.service, ids.timed)).value.time!.map((entry) => entry.limit),
            ).toEqual([5, 3]);
        });

        it('refuses a slot id the option already has', async () => {
            const ids = await catalogue();

            expectError(
                await t.http
                    .post(`${t.prefix}/services/${ids.service}/options/${ids.option}/slots`)
                    .set('Authorization', bearer)
                    .send({ id: ids.apply, child_type: 'apply', value: {} }),
                409,
                'CONFLICT',
            );
        });
    });

    describe('interval ranges', () => {
        const rangeService = async () => {
            const res = await t.http
                .post(`${t.prefix}/services`)
                .set('Authorization', bearer)
                .send({
                    organization_id: organization.id,
                    label: 'Rooms',
                    status: 'published',
                    options: [
                        {
                            label: 'Room',
                            service_type: 'service_apply',
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
            const option = res.body.data.options[0];

            return {
                service: res.body.data.id as string,
                option: option.id as string,
                timed: option.slots[0].id as string,
                dated: '',
                apply: '',
            };
        };

        it('keeps every booked interval inside the range and fills unchanged fields from the slot', async () => {
            const ids = await rangeService();
            const booked = await t.http
                .post(`${t.prefix}/services/${ids.service}/bookings`)
                .set('Authorization', await fx.bearer(await fx.client()))
                .send({ option_id: ids.option, slot_id: ids.timed, time: '12:00', end_time: '13:00' });
            expect(booked.status).toBe(201);

            expectError(await patchSlot(ids, ids.timed, { to: '12:30' }), 409, 'SLOT_TIME_BOOKED');
            expectError(await patchSlot(ids, ids.timed, { from: '12:30' }), 409, 'SLOT_TIME_BOOKED');

            const widened = await patchSlot(ids, ids.timed, { from: '07:00', max_minutes: 120 });
            expect(widened.status).toBe(200);
            expect((await fx.storedSlot(ids.service, ids.timed)).value).toMatchObject({
                from: '07:00',
                to: '14:00',
                step_minutes: 30,
                min_minutes: 60,
                max_minutes: 120,
            });
        });
    });

    describe('options', () => {
        it('changes the service type only when every slot fits the new one', async () => {
            const ids = await catalogue();
            const patchOption = (body: Record<string, unknown>) =>
                t.http
                    .patch(`${t.prefix}/services/${ids.service}/options/${ids.option}`)
                    .set('Authorization', bearer)
                    .send(body);

            expectError(await patchOption({ service_type: 'service_payment' }), 422);
            expect((await patchOption({ service_type: 'service_apply' })).status).toBe(200);
        });

        it('clears the recurrence with null and leaves the other kind untouched', async () => {
            const ids = await catalogue();
            const recurrence = (body: Record<string, unknown>) =>
                t.http
                    .put(`${t.prefix}/services/${ids.service}/options/${ids.option}/recurrence`)
                    .set('Authorization', bearer)
                    .send(body);

            const set = await recurrence({
                recurrent_dates: [{ day: 'monday', time: [{ time: '10:00' }] }],
            });
            expect(set.status).toBe(200);
            expect(set.body.data.options[0].recurrent_dates).toEqual([
                { day: 'monday', time: [{ time: '10:00', limit: null }], limit: null },
            ]);

            const cleared = await recurrence({ recurrent_dates: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.data.options[0].recurrent_dates ?? null).toBeNull();
            expectError(await recurrence({}), 400, 'VALIDATION_ERROR');
        });
    });

    describe('availability', () => {
        const slots = (ids: Ids, query = '', token?: string) => {
            const req = t.http.get(`${t.prefix}/services/${ids.service}/slots${query}`);

            return token ? req.set('Authorization', token) : req;
        };

        it('lists the bookable moments ordered by start, undated ones last', async () => {
            const ids = await catalogue();

            const res = await slots(ids);
            expect(res.status).toBe(200);
            expect(
                res.body.data.items.map((item: { slot_id: string; time: string | null }) => [
                    item.slot_id,
                    item.time,
                ]),
            ).toEqual([
                [ids.timed, '09:00'],
                [ids.timed, '15:00'],
                [ids.dated, null],
                [ids.apply, null],
            ]);
            expect(res.body.data.items[0]).toMatchObject({ limit: 1, booked_count: 0, available: 1 });
            expect(res.body.data.items[3].available).toBeNull();
        });

        it('narrows by option, date horizon, time window and free places', async () => {
            const ids = await catalogue();
            await fx.booking({
                service_id: ids.service,
                organization_id: organization.id,
                option_id: ids.option,
                slot_id: ids.timed,
                user_id: (await fx.client()).id,
                time: '09:00',
            });

            expect((await slots(ids, `?option_id=${randomUUID()}`)).body.data.total).toBe(0);
            expect((await slots(ids, `?to=${dateOnly(3)}`)).body.data.total).toBe(3);
            expect((await slots(ids, `?from=${dateOnly(4)}&to=${dateOnly(4)}`)).body.data.total).toBe(1);

            const after = new Date(`${dateOnly(2)}T12:00:00Z`).toISOString();
            const windowed = await slots(ids, `?after=${encodeURIComponent(after)}`);
            expect(
                windowed.body.data.items.map((item: { slot_id: string; time: string | null }) => [
                    item.slot_id,
                    item.time,
                ]),
            ).toEqual([
                [ids.timed, '15:00'],
                [ids.dated, null],
            ]);

            const before = new Date(`${dateOnly(2)}T12:00:00Z`).toISOString();
            const early = await slots(ids, `?before=${encodeURIComponent(before)}`);
            expect(early.body.data.items.map((item: { time: string }) => item.time)).toEqual(['09:00']);

            const free = await slots(ids, '?only_available=true');
            expect(free.body.data.items.some((item: { time: string }) => item.time === '09:00')).toBe(false);

            expect((await slots(ids, '?limit=1')).body.data).toMatchObject({
                total: 4,
                items: [expect.any(Object)],
            });
        });

        it('skips disabled options and info-only slots', async () => {
            const ids = await catalogue();
            const infoOnly = randomUUID();
            await t.http
                .post(`${t.prefix}/services/${ids.service}/options`)
                .set('Authorization', bearer)
                .send({
                    label: 'Delivery',
                    service_type: 'service_delivery',
                    slots: [{ id: infoOnly, child_type: 'pickup', value: { address: 'Desk 1' } }],
                });
            await t.http
                .patch(`${t.prefix}/services/${ids.service}/options/${ids.option}`)
                .set('Authorization', bearer)
                .send({ enabled: false });

            expect((await slots(ids)).body.data.items).toEqual([]);
        });

        it('hides a draft service from everyone but its staff', async () => {
            const ids = await catalogue({ status: 'draft', enabled: false });

            expectError(await slots(ids), 404, 'SERVICE_NOT_FOUND');
            expect((await slots(ids, '', bearer)).status).toBe(200);
        });
    });
});
