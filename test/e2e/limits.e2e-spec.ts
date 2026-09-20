import { randomUUID } from 'node:crypto';

import { expectError } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('public read limits (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('pagination depth', () => {
        it('answers an empty page beyond the data set and refuses one beyond the configured depth', async () => {
            await fx.organization();
            const beyondData = await t.http.get(`${t.prefix}/organizations?page=50&limit=10`);
            expect(beyondData.status).toBe(200);
            expect(beyondData.body.data).toEqual([]);
            expect(beyondData.body.meta).toMatchObject({ page: 50, total: 1, has_next: false });

            const tooDeep = t.config.pagination.maxPage + 1;
            expectError(
                await t.http.get(`${t.prefix}/organizations?page=${tooDeep}`),
                422,
                'PAGE_OUT_OF_RANGE',
            );
            expectError(await t.http.get(`${t.prefix}/services?page=100000000`), 422, 'PAGE_OUT_OF_RANGE');
        });
    });

    describe('organization tree', () => {
        it('caps every child list and keeps bookings out of the response', async () => {
            const organization = await fx.organization();
            const limit = t.config.pagination.includeMaxItems;

            for (let i = 0; i < limit + 5; i += 1) {
                const slotId = randomUUID();
                const optionId = randomUUID();
                const service = await fx.service(organization.id, {
                    options: [
                        {
                            id: optionId,
                            label: 'x',
                            service_type: 'service_apply',
                            enabled: true,
                            slots: [
                                {
                                    id: slotId,
                                    label: 'd',
                                    child_type: 'date_time',
                                    value: {
                                        date: '2999-01-01',
                                        time: [{ time: '10:00', limit: null, booked_count: 0 }],
                                    },
                                },
                            ],
                        },
                    ],
                });

                for (let booked = 0; booked < 20; booked += 1) {
                    await fx.booking({
                        service_id: service.id,
                        organization_id: organization.id,
                        option_id: optionId,
                        slot_id: slotId,
                        user_id: (await fx.client()).id,
                        time: '10:00',
                        person: 'Secret Person',
                        phone: '4915291112233',
                        info: 'x'.repeat(200),
                    });
                }
            }

            for (let i = 0; i < limit + 3; i += 1) await fx.news(organization.id);

            const res = await t.http.get(`${t.prefix}/organizations/${organization.id}`);
            expect(res.status).toBe(200);
            expect(res.body.data.services).toHaveLength(limit);
            expect(res.body.data.news).toHaveLength(limit);
            const card = res.body.data.services[0];
            expect(card.options).toBeUndefined();
            expect(card.options_count).toBe(1);
            expect(JSON.stringify(res.body)).not.toContain('Secret Person');
            expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(200_000);
        });
    });

    describe('legacy data', () => {
        it('serializes rows the input schemas would reject, and drops only the unserializable one', async () => {
            const organization = await fx.organization();
            await fx.service(organization.id, {
                label: 'legacy',
                value: { heading_value: 'Legacy', subscribe: 'not-an-email', link_value: 'not a url' },
                options: [
                    {
                        id: randomUUID(),
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        slots: [
                            {
                                id: randomUUID(),
                                label: 'd',
                                child_type: 'date_time',
                                value: {
                                    date: '01.01.2020',
                                    time: [{ time: 'morning', limit: null, booked_count: 0 }],
                                },
                            },
                            {
                                id: randomUUID(),
                                label: 'i',
                                child_type: 'delivery',
                                value: { link: 'javascript-ish' },
                            },
                        ],
                    },
                ],
            });
            const healthy = await fx.service(organization.id, { label: 'healthy' });

            const list = await t.http.get(`${t.prefix}/services?organization_id=${organization.id}`);
            expect(list.status).toBe(200);
            expect(list.body.data).toHaveLength(2);
            const legacy = list.body.data.find((item: { label: string }) => item.label === 'legacy');
            expect(legacy.value.subscribe).toBeUndefined();
            expect(legacy.options[0].slots[0].value.date).toBe('01.01.2020');

            const detail = await t.http.get(`${t.prefix}/services/${healthy.id}`);
            expect(detail.status).toBe(200);

            await fx
                .collection('Service')
                .updateOne(
                    { label: 'legacy' },
                    { $set: { 'options.0.slots.0.child_type': 'something_unknown' } },
                );
            const afterBreakage = await t.http.get(`${t.prefix}/services?organization_id=${organization.id}`);
            expect(afterBreakage.status).toBe(200);
            expect(afterBreakage.body.data).toHaveLength(1);
            expect(afterBreakage.body.data[0].label).toBe('healthy');
        });
    });
});
