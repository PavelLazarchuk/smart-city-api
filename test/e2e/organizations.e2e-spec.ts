import { Types } from 'mongoose';

import { expectError, expectNoSensitiveKeys, waitFor } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('organizations (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('GET /organizations', () => {
        it('is public, paginated (default 30, max 100) and carries counts', async () => {
            const organization = await fx.organization();
            await fx.news(organization.id);
            await fx.news(organization.id);
            await fx.category(organization.id);
            await fx.service(organization.id);

            for (let i = 0; i < 40; i += 1) await fx.organization();

            const res = await t.http.get(`${t.prefix}/organizations?sort=created_at&order=asc`);
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(30);
            expect(res.body.meta).toEqual({ page: 1, limit: 30, total: 41, total_pages: 2, has_next: true });
            const row = res.body.data.find((item: { id: string }) => item.id === organization.id);
            expect(row.counts).toEqual({ news: 2, infosections: 0, categories: 1, services: 1, images: 0 });
            expect(row.news).toBeUndefined();

            const clamped = await t.http.get(`${t.prefix}/organizations?limit=500&page=2`);
            expect(clamped.body.meta.limit).toBe(100);
            expect(clamped.body.data).toHaveLength(0);
            expect(clamped.body.meta.has_next).toBe(false);

            const page2 = await t.http.get(`${t.prefix}/organizations?page=2&sort=created_at&order=asc`);
            expect(page2.body.data).toHaveLength(11);
            const ids = [...res.body.data, ...page2.body.data].map((item: { id: string }) => item.id);
            expect(new Set(ids).size).toBe(41);
        });

        it('supports ?main_category=, ?q=, ?empty=true and ?include=', async () => {
            const a = await fx.organization({ main_label: 'Central Clinic', main_category: 'healthcare' });
            const b = await fx.organization({ main_label: 'City Library', main_category: 'culture' });
            await fx.news(a.id);

            const byCategory = await t.http.get(`${t.prefix}/organizations?main_category=culture`);
            expect(byCategory.body.data.map((item: { id: string }) => item.id)).toEqual([b.id]);

            const search = await t.http.get(`${t.prefix}/organizations?q=library`);
            expect(search.body.data.map((item: { id: string }) => item.id)).toEqual([b.id]);

            const empty = await t.http.get(`${t.prefix}/organizations?empty=true`);
            expect(empty.body.data.map((item: { id: string }) => item.id)).toEqual([b.id]);

            const included = await t.http.get(`${t.prefix}/organizations?include=news,categories`);
            const rowA = included.body.data.find((item: { id: string }) => item.id === a.id);
            expect(rowA.news).toHaveLength(1);
            expect(rowA.categories).toEqual([]);
            expect(rowA.services).toBeUndefined();

            expectError(
                await t.http.get(`${t.prefix}/organizations?include=bookings`),
                400,
                'VALIDATION_ERROR',
            );
        });
    });

    describe('POST / PATCH / DELETE', () => {
        it('POST is super-admin only and returns 201 with Location', async () => {
            const superAdmin = await fx.superAdmin();
            const admin = await fx.admin([]);
            const body = {
                main_label: 'New Org',
                main_image: 'https://example.com/a.jpg',
                main_category: 'sport',
            };
            expectError(await t.http.post(`${t.prefix}/organizations`).send(body), 401);
            expectError(
                await t.http
                    .post(`${t.prefix}/organizations`)
                    .set('Authorization', await fx.bearer(admin))
                    .send(body),
                403,
            );
            const res = await t.http
                .post(`${t.prefix}/organizations`)
                .set('Authorization', await fx.bearer(superAdmin))
                .send(body);
            expect(res.status).toBe(201);
            expect(res.headers['location']).toBe(`/organizations/${res.body.data.id}`);
            expect(res.body.data).toMatchObject(body);
            expectError(
                await t.http
                    .post(`${t.prefix}/organizations`)
                    .set('Authorization', await fx.bearer(superAdmin))
                    .send({ main_label: 'x' }),
                400,
                'VALIDATION_ERROR',
            );
        });

        it('PATCH updates only the organization fields and respects the scope', async () => {
            const organization = await fx.organization();
            const other = await fx.organization();
            const admin = await fx.admin([organization.id]);
            const bearer = await fx.bearer(admin);
            const news = await fx.news(organization.id);

            const res = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', bearer)
                .send({ main_label: 'Renamed', category: null, news: [{ id: news.id, label: 'hacked' }] });
            expect(res.status).toBe(200);
            expect(res.body.data.main_label).toBe('Renamed');
            expect(res.body.data.news).toBeUndefined();
            const untouched = await fx.collection<{ label: string }>('News').findById(news.id).lean();
            expect(untouched?.label).not.toBe('hacked');

            expectError(
                await t.http
                    .patch(`${t.prefix}/organizations/${other.id}`)
                    .set('Authorization', bearer)
                    .send({ main_label: 'x' }),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http
                    .patch(`${t.prefix}/organizations/64b000000000000000000000`)
                    .set('Authorization', await fx.bearer(await fx.superAdmin()))
                    .send({ main_label: 'x' }),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
        });

        it('DELETE cascades to every nested collection and detaches admins, inside a transaction', async () => {
            const superAdmin = await fx.superAdmin();
            const organization = await fx.organization();
            const admin = await fx.admin([organization.id]);
            const category = await fx.category(organization.id);
            await fx.service(organization.id, { category_id: category.id });
            await fx.service(organization.id);
            await fx.news(organization.id);
            await fx.infoSection(organization.id);
            await fx.collection('Image').create({
                organization_id: new Types.ObjectId(organization.id),
                name: `${organization.id}/x.png`,
                src: 'http://localhost/x.png',
                mime_type: 'image/png',
                size: 10,
            });
            await fx
                .collection('Archive')
                .create({ organization_id: new Types.ObjectId(organization.id), type: 'news', data: {} });

            const res = await t.http
                .delete(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(res.status).toBe(204);

            const orgFilter = { organization_id: new Types.ObjectId(organization.id) };

            for (const name of ['Category', 'Service', 'News', 'InfoSection', 'Image', 'Archive']) {
                expect(await fx.collection(name).countDocuments(orgFilter)).toBe(0);
            }

            const detached = await fx
                .collection<{ organization_ids: Types.ObjectId[] }>('User')
                .findById(admin.id)
                .lean();
            expect(detached?.organization_ids).toEqual([]);
            expectError(
                await t.http.get(`${t.prefix}/organizations/${organization.id}`),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
            expectError(
                await t.http
                    .delete(`${t.prefix}/organizations/${organization.id}`)
                    .set('Authorization', await fx.bearer(admin)),
                403,
            );
        });
    });

    describe('GET /organizations/:id', () => {
        it('returns the full tree with two independent arrays and masks bookings for the public', async () => {
            const organization = await fx.organization();
            const category = await fx.category(organization.id);
            const option = fx.bookableOption(2);
            option.slots[0]!.value.time![0]!.bookings.push({
                id: '11111111-1111-4111-8111-111111111111',
                user_id: new Types.ObjectId(),
                person: 'Secret Person',
                phone: '375291112233',
                info: '',
                created_at: new Date(),
            });
            option.slots[0]!.value.time![0]!.booked_count = 1;
            await fx.service(organization.id, {
                category_id: category.id,
                options: [option],
                value: { subscribe: 'internal@example.com' },
            });
            await fx.service(organization.id);
            await fx.news(organization.id);
            await fx.infoSection(organization.id);

            const res = await t.http.get(`${t.prefix}/organizations/${organization.id}`);
            expect(res.status).toBe(200);
            expect(res.body.data.categories).toHaveLength(1);
            expect(res.body.data.categories[0].services).toHaveLength(1);
            expect(res.body.data.services).toHaveLength(1);
            expect(res.body.data.news).toHaveLength(1);
            expect(res.body.data.infosections).toHaveLength(1);
            const nested = res.body.data.categories[0].services[0];
            expect(nested.value.subscribe).toBeUndefined();
            expect(nested.options[0].slots[0].value.time[0].bookings).toEqual([{ status: 'reserved' }]);
            expect(JSON.stringify(res.body)).not.toContain('Secret Person');
            expectNoSensitiveKeys(res.body);

            expect(nested.options[0].slots[0].value.time[0].booked_count).toBe(1);

            const admin = await fx.admin([organization.id]);
            const asAdmin = await t.http
                .get(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', await fx.bearer(admin));
            const adminNested = asAdmin.body.data.categories[0].services[0];
            expect(adminNested.value.subscribe).toBeUndefined();
            expect(adminNested.options[0].slots[0].value.time[0].bookings).toEqual([{ status: 'reserved' }]);
            expect(JSON.stringify(asAdmin.body)).not.toContain('Secret Person');

            const service = await t.http
                .get(`${t.prefix}/services/${asAdmin.body.data.categories[0].services[0].id}`)
                .set('Authorization', await fx.bearer(admin));
            expect(service.body.data.value.subscribe).toBe('internal@example.com');
            expect(service.body.data.options[0].slots[0].value.time[0].bookings[0].person).toBe(
                'Secret Person',
            );

            const foreignAdmin = await fx.admin([(await fx.organization()).id]);
            const asForeign = await t.http
                .get(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', await fx.bearer(foreignAdmin));
            expect(JSON.stringify(asForeign.body)).not.toContain('Secret Person');
        });

        it('records an analytics event for the view', async () => {
            const organization = await fx.organization();
            await t.http.get(`${t.prefix}/organizations/${organization.id}`);
            const events = await waitFor(async () => {
                const rows = await fx
                    .collection<{ type: string }>('AnalyticsEvent')
                    .find({
                        type: 'organization.viewed',
                        organization_id: new Types.ObjectId(organization.id),
                    })
                    .lean();

                return rows.length > 0 ? rows : null;
            });
            expect(events).toHaveLength(1);
        });
    });

    describe('sub-resources and reorder', () => {
        it('lists paginated children and reorders each list independently', async () => {
            const organization = await fx.organization();
            const admin = await fx.admin([organization.id]);
            const bearer = await fx.bearer(admin);
            const n1 = await fx.news(organization.id, { position: 0 });
            const n2 = await fx.news(organization.id, { position: 1 });
            const s1 = await fx.service(organization.id, { position: 0 });
            const s2 = await fx.service(organization.id, { position: 1 });
            const category = await fx.category(organization.id);
            const cs = await fx.service(organization.id, { category_id: category.id, position: 0 });

            const list = await t.http.get(`${t.prefix}/organizations/${organization.id}/news?limit=1`);
            expect(list.body.data.map((item: { id: string }) => item.id)).toEqual([n1.id]);
            expect(list.body.meta.total).toBe(2);

            const reorder = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}/news/order`)
                .set('Authorization', bearer)
                .send({ ids: [n2.id, n1.id] });
            expect(reorder.status).toBe(204);
            const after = await t.http.get(`${t.prefix}/organizations/${organization.id}/news`);
            expect(after.body.data.map((item: { id: string }) => item.id)).toEqual([n2.id, n1.id]);

            const mismatch = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}/services/order`)
                .set('Authorization', bearer)
                .send({ ids: [s2.id, s1.id, cs.id] });
            expectError(mismatch, 422, 'REORDER_MISMATCH');
            const ok = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}/services/order`)
                .set('Authorization', bearer)
                .send({ ids: [s2.id, s1.id] });
            expect(ok.status).toBe(204);
            const tree = await t.http.get(`${t.prefix}/organizations/${organization.id}`);
            expect(tree.body.data.services.map((item: { id: string }) => item.id)).toEqual([s2.id, s1.id]);
            expect(tree.body.data.categories[0].services.map((item: { id: string }) => item.id)).toEqual([
                cs.id,
            ]);

            const foreign = await fx.admin([(await fx.organization()).id]);
            expectError(
                await t.http
                    .patch(`${t.prefix}/organizations/${organization.id}/news/order`)
                    .set('Authorization', await fx.bearer(foreign))
                    .send({ ids: [n1.id, n2.id] }),
                403,
            );
        });
    });
});
