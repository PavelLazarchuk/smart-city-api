import { Types } from 'mongoose';

import { expectError, expectNoSensitiveKeys } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('content resources (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let foreignOrganization: { id: string };
    let superAdmin: FixtureUser;
    let admin: FixtureUser;
    let foreignAdmin: FixtureUser;
    let client: FixtureUser;
    const bearers: Record<string, string> = {};

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        foreignOrganization = await fx.organization();
        superAdmin = await fx.superAdmin();
        admin = await fx.admin([organization.id]);
        foreignAdmin = await fx.admin([foreignOrganization.id]);
        client = await fx.client();
        bearers['super'] = await fx.bearer(superAdmin);
        bearers['admin'] = await fx.bearer(admin);
        bearers['foreign'] = await fx.bearer(foreignAdmin);
        bearers['client'] = await fx.bearer(client);
    });

    const resources = [
        {
            name: 'categories',
            not_found: 'CATEGORY_NOT_FOUND',
            body: () => ({ organization_id: organization.id, label: 'Category', enabled: true }),
            patch: { label: 'Renamed' },
            create: () => fx.category(organization.id),
        },
        {
            name: 'services',
            not_found: 'SERVICE_NOT_FOUND',
            body: () => ({
                organization_id: organization.id,
                label: 'Service',
                options: [{ slots: [{ child_type: 'apply', value: { limit: 3 } }] }],
            }),
            patch: { label: 'Renamed' },
            create: () => fx.service(organization.id),
        },
        {
            name: 'news',
            not_found: 'NEWS_NOT_FOUND',
            body: () => ({
                organization_id: organization.id,
                label: 'News',
                value: { heading_value: 'Hello' },
                is_main: true,
            }),
            patch: { label: 'Renamed' },
            create: () => fx.news(organization.id),
        },
        {
            name: 'infosections',
            not_found: 'INFOSECTION_NOT_FOUND',
            body: () => ({
                organization_id: organization.id,
                label: 'Address',
                control: 'address',
                value: { text: 'Main st', lat: '53.9', lng: '27.5' },
            }),
            patch: { label: 'Renamed' },
            create: () => fx.infoSection(organization.id),
        },
    ] as const;

    describe.each(resources)('$name', (resource) => {
        it('authorization matrix: create / update / delete', async () => {
            const url = `${t.prefix}/${resource.name}`;
            expectError(await t.http.post(url).send(resource.body()), 401, 'UNAUTHENTICATED');
            expectError(
                await t.http.post(url).set('Authorization', bearers['client']!).send(resource.body()),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http.post(url).set('Authorization', bearers['foreign']!).send(resource.body()),
                403,
                'FORBIDDEN',
            );

            const created = await t.http
                .post(url)
                .set('Authorization', bearers['admin']!)
                .send(resource.body());
            expect(created.status).toBe(201);
            expect(created.headers['location']).toBe(`/${resource.name}/${created.body.data.id}`);
            expect(created.body.data.organization_id).toBe(organization.id);
            expect(created.body.data.position).toBe(0);
            expectNoSensitiveKeys(created.body);
            const id = created.body.data.id as string;

            const bySuper = await t.http
                .post(url)
                .set('Authorization', bearers['super']!)
                .send(resource.body());
            expect(bySuper.status).toBe(201);
            expect(bySuper.body.data.position).toBe(1);

            expectError(
                await t.http
                    .patch(`${url}/${id}`)
                    .set('Authorization', bearers['foreign']!)
                    .send(resource.patch),
                404,
                resource.not_found,
            );
            expectError(
                await t.http
                    .patch(`${url}/${id}`)
                    .set('Authorization', bearers['client']!)
                    .send(resource.patch),
                403,
                'FORBIDDEN',
            );
            const updated = await t.http
                .patch(`${url}/${id}`)
                .set('Authorization', bearers['admin']!)
                .send(resource.patch);
            expect(updated.status).toBe(200);
            expect(updated.body.data.label).toBe('Renamed');
            expect(updated.body.data.organization_id).toBe(organization.id);

            expectError(
                await t.http.delete(`${url}/${id}`).set('Authorization', bearers['foreign']!),
                404,
                resource.not_found,
            );
            expect((await t.http.delete(`${url}/${id}`).set('Authorization', bearers['admin']!)).status).toBe(
                204,
            );
            expectError(await t.http.get(`${url}/${id}`), 404);
            expectError(await t.http.delete(`${url}/${id}`).set('Authorization', bearers['super']!), 404);
            expectError(
                await t.http
                    .patch(`${url}/not-an-id`)
                    .set('Authorization', bearers['super']!)
                    .send(resource.patch),
                404,
            );
        });

        it('public reads with pagination and validation', async () => {
            await resource.create();
            await resource.create();
            const list = await t.http.get(
                `${t.prefix}/${resource.name}?organization_id=${organization.id}&limit=1`,
            );
            expect(list.status).toBe(200);
            expect(list.body.data).toHaveLength(1);
            expect(list.body.meta).toMatchObject({ total: 2, limit: 1, has_next: true });
            const one = await t.http.get(`${t.prefix}/${resource.name}/${list.body.data[0].id}`);
            expect(one.status).toBe(200);
            expectError(await t.http.get(`${t.prefix}/${resource.name}?limit=abc`), 400, 'VALIDATION_ERROR');
            expectError(
                await t.http
                    .post(`${t.prefix}/${resource.name}`)
                    .set('Authorization', bearers['super']!)
                    .send({ label: 'x' }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(
                await t.http
                    .post(`${t.prefix}/${resource.name}`)
                    .set('Authorization', bearers['super']!)
                    .send({ ...resource.body(), organization_id: '64b000000000000000000000' }),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
        });
    });

    describe('categories → services', () => {
        it('validates category ownership, reorders inside a category and cascades on delete', async () => {
            const category = await fx.category(organization.id);
            const foreignCategory = await fx.category(foreignOrganization.id);
            const mismatch = await t.http
                .post(`${t.prefix}/services`)
                .set('Authorization', bearers['admin']!)
                .send({ organization_id: organization.id, category_id: foreignCategory.id });
            expectError(mismatch, 422, 'CATEGORY_ORGANIZATION_MISMATCH');

            const s1 = await fx.service(organization.id, { category_id: category.id, position: 0 });
            const s2 = await fx.service(organization.id, { category_id: category.id, position: 1 });
            const reorder = await t.http
                .patch(`${t.prefix}/categories/${category.id}/services/order`)
                .set('Authorization', bearers['admin']!)
                .send({ ids: [s2.id, s1.id] });
            expect(reorder.status).toBe(204);
            const listed = await t.http.get(`${t.prefix}/services?category_id=${category.id}`);
            expect(listed.body.data.map((item: { id: string }) => item.id)).toEqual([s2.id, s1.id]);
            expectError(
                await t.http
                    .patch(`${t.prefix}/categories/${category.id}/services/order`)
                    .set('Authorization', bearers['foreign']!)
                    .send({ ids: [s1.id, s2.id] }),
                404,
                'CATEGORY_NOT_FOUND',
            );

            const moved = await t.http
                .patch(`${t.prefix}/services/${s1.id}`)
                .set('Authorization', bearers['admin']!)
                .send({ category_id: null });
            expect(moved.body.data.category_id).toBeNull();

            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/categories/${category.id}`)
                        .set('Authorization', bearers['admin']!)
                ).status,
            ).toBe(204);
            expect(
                await fx
                    .collection('Service')
                    .countDocuments({ category_id: new Types.ObjectId(category.id) }),
            ).toBe(0);
            expect(await fx.collection('Service').countDocuments({ _id: new Types.ObjectId(s1.id) })).toBe(1);
        });
    });

    describe('news filters and expiry fields', () => {
        it('supports ?main=true and ?offers=true and stores promoted fields', async () => {
            await fx.news(organization.id, { is_main: true });
            await fx.news(organization.id, { is_offer: true });
            await fx.news(organization.id);
            expect((await t.http.get(`${t.prefix}/news?main=true`)).body.meta.total).toBe(1);
            expect((await t.http.get(`${t.prefix}/news?offers=true`)).body.meta.total).toBe(1);
            expect((await t.http.get(`${t.prefix}/news`)).body.meta.total).toBe(3);

            const created = await t.http
                .post(`${t.prefix}/news`)
                .set('Authorization', bearers['admin']!)
                .send({
                    organization_id: organization.id,
                    label: 'Expiring',
                    expires_at: '2030-01-01T00:00:00.000Z',
                    date: '2026-01-01T10:00:00.000Z',
                });
            expect(created.status).toBe(201);
            expect(created.body.data.expires_at).toBe('2030-01-01T00:00:00.000Z');
            const cleared = await t.http
                .patch(`${t.prefix}/news/${created.body.data.id}`)
                .set('Authorization', bearers['admin']!)
                .send({ expires_at: null });
            expect(cleared.body.data.expires_at).toBeUndefined();
        });
    });

    describe('infosections discriminated union', () => {
        it('rejects a value that does not match its control', async () => {
            const bad = await t.http
                .post(`${t.prefix}/infosections`)
                .set('Authorization', bearers['admin']!)
                .send({
                    organization_id: organization.id,
                    label: 'Link',
                    control: 'link',
                    value: { text: 'no url' },
                });
            expectError(bad, 400, 'VALIDATION_ERROR');
            const good = await t.http
                .post(`${t.prefix}/infosections`)
                .set('Authorization', bearers['admin']!)
                .send({
                    organization_id: organization.id,
                    label: 'Link',
                    control: 'link',
                    value: { url: 'https://example.com', junk: 1 },
                });
            expect(good.status).toBe(201);
            expect(good.body.data.value).toEqual({ url: 'https://example.com' });
            const switched = await t.http
                .patch(`${t.prefix}/infosections/${good.body.data.id}`)
                .set('Authorization', bearers['admin']!)
                .send({ control: 'email', value: { email: 'a@b.co' } });
            expect(switched.body.data.control).toBe('email');
            expectError(
                await t.http
                    .patch(`${t.prefix}/infosections/${good.body.data.id}`)
                    .set('Authorization', bearers['admin']!)
                    .send({ control: 'email' }),
                400,
            );
        });
    });

    describe('services options', () => {
        it('validates slot shapes per child_type and keeps bookings when options are replaced', async () => {
            const bad = await t.http
                .post(`${t.prefix}/services`)
                .set('Authorization', bearers['admin']!)
                .send({
                    organization_id: organization.id,
                    options: [
                        { slots: [{ child_type: 'date_time', value: { date: 'tomorrow', time: [] } }] },
                    ],
                });
            expectError(bad, 400, 'VALIDATION_ERROR');

            const option = fx.bookableOption(2);
            const slot = option.slots[0]!;
            const service = await fx.service(organization.id, { options: [option] });
            await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: slot.id,
                user_id: client.id,
                time: '10:00',
                person: 'P',
            });

            const replaced = await t.http
                .patch(`${t.prefix}/services/${service.id}`)
                .set('Authorization', bearers['admin']!)
                .send({
                    options: [
                        {
                            id: option.id,
                            label: 'Renamed option',
                            slots: [
                                {
                                    id: slot.id,
                                    child_type: 'date_time',
                                    value: {
                                        date: slot.value.date,
                                        time: [{ time: '10:00', limit: 5 }, { time: '11:00' }],
                                    },
                                },
                            ],
                        },
                    ],
                });
            expect(replaced.status).toBe(200);
            const time = replaced.body.data.options[0].slots[0].value.time;
            expect(time[0]).toMatchObject({ time: '10:00', limit: 5, booked_count: 1 });
            expect(time[0].bookings).toHaveLength(1);
            expect(time[1]).toMatchObject({ time: '11:00', limit: null, booked_count: 0, bookings: [] });
        });
    });
});
