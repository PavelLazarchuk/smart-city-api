import { randomUUID } from 'node:crypto';

import { type OptionTree } from '../../src/modules/services/slot.logic';
import { expectError } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('temporary closure (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let clientBearer: string;
    let adminBearer: string;
    const ids = { option: randomUUID(), soon: randomUUID(), later: randomUUID(), apply: randomUUID() };

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization({
            status: 'temporarily_closed',
            closed_until: new Date(`${dateOnly(3)}T00:00:00Z`),
        });
        clientBearer = await fx.bearer(await fx.client());
        adminBearer = await fx.bearer(await fx.admin([organization.id]));
    });

    const service = () => {
        const option: OptionTree = {
            id: ids.option,
            label: 'Main',
            service_type: 'service_apply',
            enabled: true,
            slots: [
                {
                    id: ids.soon,
                    label: 'Soon',
                    child_type: 'date_time',
                    value: { date: dateOnly(1), time: [{ time: '10:00', limit: 2, booked_count: 0 }] },
                },
                {
                    id: ids.later,
                    label: 'Later',
                    child_type: 'date_time',
                    value: { date: dateOnly(5), time: [{ time: '10:00', limit: 2, booked_count: 0 }] },
                },
                {
                    id: ids.apply,
                    label: 'Apply',
                    child_type: 'apply',
                    value: { limit: null, booked_count: 0 },
                },
            ],
        };

        return fx.service(organization.id, { options: [option] });
    };

    const book = (serviceId: string, slotId: string, bearer = clientBearer) =>
        t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', bearer)
            .send({
                option_id: ids.option,
                slot_id: slotId,
                ...(slotId === ids.apply ? {} : { time: '10:00' }),
            });

    it('accepts bookings for after the reopening and refuses the closed period', async () => {
        const { id } = await service();

        expect((await book(id, ids.later)).status).toBe(201);
        expectError(await book(id, ids.soon), 422, 'ORGANIZATION_CLOSED');
        expectError(await book(id, ids.apply), 422, 'ORGANIZATION_CLOSED');
        expect((await book(id, ids.soon, adminBearer)).status).toBe(201);
    });

    it('hides the closed period from clients in availability and slot listings', async () => {
        const { id } = await service();
        const slotIds = (res: { body: { data: { options: { slots: { id: string }[] }[] } } }) =>
            res.body.data.options.flatMap((option) => option.slots.map((slot) => slot.id));

        const forClient = await t.http.get(`${t.prefix}/services/${id}/availability`);
        expect(slotIds(forClient)).toEqual([ids.later]);

        const forStaff = await t.http
            .get(`${t.prefix}/services/${id}/availability`)
            .set('Authorization', adminBearer);
        expect(slotIds(forStaff).sort()).toEqual([ids.soon, ids.later, ids.apply].sort());

        const candidates = await t.http.get(`${t.prefix}/services/${id}/slots`);
        expect(candidates.body.data.items.map((item: { slot_id: string }) => item.slot_id)).toEqual([
            ids.later,
        ]);
    });

    it('treats a closure without an end date as closed for every date', async () => {
        await fx.collection('Organization').updateOne({}, { $set: { closed_until: null } });
        const { id } = await service();

        expectError(await book(id, ids.later), 422, 'ORGANIZATION_CLOSED');
        const availability = await t.http.get(`${t.prefix}/services/${id}/availability`);
        expect(availability.body.data.options).toEqual([]);
    });
});
