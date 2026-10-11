import { Types } from 'mongoose';

import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('content editing (e2e)', () => {
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

    const organizationStamp = async (): Promise<number> =>
        (await fx
            .collection<{ updated_at: Date }>('Organization')
            .findById(organization.id)
            .lean<{ updated_at: Date }>())!.updated_at.getTime();

    const patch = (path: string, body: Record<string, unknown>, token = bearer) =>
        t.http.patch(`${t.prefix}${path}`).set('Authorization', token).send(body);

    describe('categories', () => {
        it('sets and clears a description and leaves the organization alone on an empty patch', async () => {
            const category = await fx.category(organization.id, { label: 'Clinic' });

            const described = await patch(`/categories/${category.id}`, { description: 'Walk-in hours' });
            expect(described.status).toBe(200);
            expect(described.body.data.description).toBe('Walk-in hours');

            const cleared = await patch(`/categories/${category.id}`, {
                description: null,
                label: 'Renamed',
            });
            expect(cleared.body.data.description).toBeUndefined();
            expect(cleared.body.data.label).toBe('Renamed');

            const before = await organizationStamp();
            await new Promise((resolve) => setTimeout(resolve, 5));
            const untouched = await patch(`/categories/${category.id}`, {});
            expect(untouched.status).toBe(200);
            expect(untouched.body.data.label).toBe('Renamed');
            expect(await organizationStamp()).toBe(before);
        });

        it('hides a disabled category from the public and clients but shows it to its staff', async () => {
            const hidden = await fx.category(organization.id, { enabled: false });
            await fx.category(organization.id);

            expectError(await t.http.get(`${t.prefix}/categories/${hidden.id}`), 404, 'CATEGORY_NOT_FOUND');
            expectError(
                await t.http
                    .get(`${t.prefix}/categories/${hidden.id}`)
                    .set('Authorization', await fx.bearer(await fx.client())),
                404,
                'CATEGORY_NOT_FOUND',
            );
            const own = await t.http.get(`${t.prefix}/categories/${hidden.id}`).set('Authorization', bearer);
            expect(own.status).toBe(200);
            expect(own.body.data.enabled).toBe(false);

            const publicList = await t.http.get(`${t.prefix}/categories?organization_id=${organization.id}`);
            expect(publicList.body.meta.total).toBe(1);
            const staffDrafts = await t.http
                .get(`${t.prefix}/categories?organization_id=${organization.id}&enabled=false`)
                .set('Authorization', bearer);
            expect(staffDrafts.body.data.map((row: { id: string }) => row.id)).toEqual([hidden.id]);
        });

        it('creates a draft by default and answers 404 for an unknown category', async () => {
            const created = await t.http
                .post(`${t.prefix}/categories`)
                .set('Authorization', bearer)
                .send({ organization_id: organization.id, label: 'Draft' });
            expect(created.status).toBe(201);
            expect(created.body.data.enabled).toBe(false);

            const missing = new Types.ObjectId().toHexString();
            expectError(await t.http.get(`${t.prefix}/categories/${missing}`), 404, 'CATEGORY_NOT_FOUND');
        });

        it('reorders categories of the organization and refuses a list that does not match', async () => {
            const first = await fx.category(organization.id, { position: 0 });
            const second = await fx.category(organization.id, { position: 1 });
            const foreign = await fx.category((await fx.organization()).id);

            const reordered = await patch(`/organizations/${organization.id}/categories/order`, {
                ids: [second.id, first.id],
            });
            expect(reordered.status).toBe(204);
            const list = await t.http.get(`${t.prefix}/organizations/${organization.id}/categories`);
            expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);

            expectError(
                await patch(`/organizations/${organization.id}/categories/order`, {
                    ids: [second.id, foreign.id],
                }),
                422,
                'REORDER_MISMATCH',
            );
        });
    });

    describe('info sections', () => {
        it('changes control and value together and ignores an empty patch', async () => {
            const section = await fx.infoSection(organization.id, { label: 'Hours' });

            const switched = await patch(`/infosections/${section.id}`, {
                control: 'link',
                value: { url: 'https://example.com/hours', text: 'Hours' },
            });
            expect(switched.status).toBe(200);
            expect(switched.body.data.control).toBe('link');
            expect(switched.body.data.value).toEqual({ url: 'https://example.com/hours', text: 'Hours' });
            expectError(
                await patch(`/infosections/${section.id}`, { control: 'email', value: { email: 'nope' } }),
                400,
                'VALIDATION_ERROR',
            );

            const disabled = await patch(`/infosections/${section.id}`, { enabled: false });
            expect(disabled.body.data.enabled).toBe(false);

            const before = await organizationStamp();
            await new Promise((resolve) => setTimeout(resolve, 5));
            const same = await patch(`/infosections/${section.id}`, {});
            expect(same.status).toBe(200);
            expect(same.body.data.label).toBe('Hours');
            expect(await organizationStamp()).toBe(before);
        });

        it('hides a disabled section from the public and filters by enabled for its staff', async () => {
            const hidden = await fx.infoSection(organization.id, { enabled: false });
            const shown = await fx.infoSection(organization.id);

            expectError(
                await t.http.get(`${t.prefix}/infosections/${hidden.id}`),
                404,
                'INFOSECTION_NOT_FOUND',
            );
            expect(
                (await t.http.get(`${t.prefix}/infosections/${hidden.id}`).set('Authorization', bearer))
                    .status,
            ).toBe(200);

            const enabled = await t.http
                .get(`${t.prefix}/infosections?organization_id=${organization.id}&enabled=true`)
                .set('Authorization', bearer);
            expect(enabled.body.data.map((row: { id: string }) => row.id)).toEqual([shown.id]);
        });

        it('reorders sections of the organization', async () => {
            const first = await fx.infoSection(organization.id, { position: 0 });
            const second = await fx.infoSection(organization.id, { position: 1 });

            expect(
                (
                    await patch(`/organizations/${organization.id}/infosections/order`, {
                        ids: [second.id, first.id],
                    })
                ).status,
            ).toBe(204);
            const list = await t.http.get(`${t.prefix}/organizations/${organization.id}/infosections`);
            expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
        });
    });

    describe('news', () => {
        it('renames the slug unless another item of the organization holds it', async () => {
            const first = await fx.news(organization.id, { slug: 'first' });
            await fx.news(organization.id, { slug: 'taken' });
            const elsewhere = await fx.news((await fx.organization()).id, { slug: 'free-here' });

            expectError(await patch(`/news/${first.id}`, { slug: 'taken' }), 409, 'NEWS_SLUG_TAKEN');
            expect((await patch(`/news/${first.id}`, { slug: 'first' })).status).toBe(200);
            const renamed = await patch(`/news/${first.id}`, { slug: 'free-here' });
            expect(renamed.status).toBe(200);
            expect(renamed.body.data.slug).toBe('free-here');
            expect(elsewhere.id).not.toBe(first.id);

            const bySlug = await t.http.get(`${t.prefix}/organizations/${organization.id}/news/free-here`);
            expect(bySlug.body.data.id).toBe(first.id);
        });

        it('sets and clears the rubric, the expiry and the publication date', async () => {
            const item = await fx.news(organization.id);

            const set = await patch(`/news/${item.id}`, {
                rubric: 'events',
                expires_at: '2099-01-01T00:00:00.000Z',
                publish_at: '2099-01-01T00:00:00.000Z',
                is_main: true,
                is_offer: true,
                date: '2026-05-01T10:00:00.000Z',
                value: { heading_value: 'Fair' },
            });
            expect(set.status).toBe(200);
            expect(set.body.data).toMatchObject({
                rubric: 'events',
                expires_at: '2099-01-01T00:00:00.000Z',
                publish_at: '2099-01-01T00:00:00.000Z',
                is_main: true,
                is_offer: true,
                date: '2026-05-01T10:00:00.000Z',
                value: { heading_value: 'Fair' },
            });

            const cleared = await patch(`/news/${item.id}`, {
                rubric: null,
                expires_at: null,
                publish_at: null,
            });
            expect(cleared.body.data.rubric).toBeUndefined();
            expect(cleared.body.data.expires_at).toBeUndefined();
            expect(cleared.body.data.publish_at).toBeNull();

            const same = await patch(`/news/${item.id}`, {});
            expect(same.body.data.id).toBe(item.id);
        });

        it('keeps a scheduled item away from the public and clients until it is due', async () => {
            const later = new Date(Date.now() + 3_600_000);
            const scheduled = await fx.news(organization.id, { slug: 'soon', publish_at: later });
            const disabled = await fx.news(organization.id, { slug: 'off', enabled: false });

            expectError(await t.http.get(`${t.prefix}/news/${scheduled.id}`), 404, 'NEWS_NOT_FOUND');
            expectError(
                await t.http.get(`${t.prefix}/organizations/${organization.id}/news/soon`),
                404,
                'NEWS_NOT_FOUND',
            );
            expectError(
                await t.http.get(`${t.prefix}/organizations/${organization.id}/news/off`),
                404,
                'NEWS_NOT_FOUND',
            );
            expectError(
                await t.http.get(`${t.prefix}/organizations/${organization.id}/news/missing`),
                404,
                'NEWS_NOT_FOUND',
            );
            expect(
                (await t.http.get(`${t.prefix}/news/${scheduled.id}`).set('Authorization', bearer)).status,
            ).toBe(200);
            expect(
                (await t.http.get(`${t.prefix}/news/${disabled.id}`).set('Authorization', bearer)).status,
            ).toBe(200);

            const publicList = await t.http.get(`${t.prefix}/news?organization_id=${organization.id}`);
            expect(publicList.body.meta.total).toBe(0);
            const staffList = await t.http
                .get(`${t.prefix}/news?organization_id=${organization.id}`)
                .set('Authorization', bearer);
            expect(staffList.body.meta.total).toBe(2);
            const superList = await t.http
                .get(`${t.prefix}/news?enabled=false`)
                .set('Authorization', await fx.bearer(await fx.superAdmin()));
            expect(superList.body.data.map((row: { id: string }) => row.id)).toEqual([disabled.id]);
        });

        it('filters by main and offer flags', async () => {
            const main = await fx.news(organization.id, { is_main: true });
            const offer = await fx.news(organization.id, { is_offer: true });
            await fx.news(organization.id);

            const mains = await t.http.get(`${t.prefix}/news?main=true`);
            expect(mains.body.data.map((row: { id: string }) => row.id)).toEqual([main.id]);
            const offers = await t.http.get(`${t.prefix}/news?offers=true`);
            expect(offers.body.data.map((row: { id: string }) => row.id)).toEqual([offer.id]);
        });

        it('lets an operator write news of its organization and deletes them for good', async () => {
            const operator = await fx.bearer(
                await fx.user({ role: 'operator', organization_ids: [organization.id] }),
            );
            const created = await t.http
                .post(`${t.prefix}/news`)
                .set('Authorization', operator)
                .send({ organization_id: organization.id, label: 'From the desk', enabled: true });
            expect(created.status).toBe(201);
            const id = created.body.data.id as string;

            expect(
                (await t.http.delete(`${t.prefix}/news/${id}`).set('Authorization', operator)).status,
            ).toBe(204);
            expectError(await t.http.get(`${t.prefix}/news/${id}`), 404, 'NEWS_NOT_FOUND');
            expectError(await t.http.delete(`${t.prefix}/news/${id}`).set('Authorization', operator), 404);
        });
    });

    describe('archives', () => {
        const archive = (organizationId: string, type: 'news' | 'service' = 'news') =>
            fx.collection('Archive').create({
                organization_id: new Types.ObjectId(organizationId),
                type,
                data: { label: type },
            });

        it('filters by type and organization for super-admins', async () => {
            const other = await fx.organization();
            await archive(organization.id, 'news');
            await archive(organization.id, 'service');
            await archive(other.id, 'service');
            const superBearer = await fx.bearer(await fx.superAdmin());

            const services = await t.http
                .get(`${t.prefix}/archives?type=service`)
                .set('Authorization', superBearer);
            expect(services.body.meta.total).toBe(2);
            const ofOther = await t.http
                .get(`${t.prefix}/archives?organization_id=${other.id}`)
                .set('Authorization', superBearer);
            expect(ofOther.body.meta.total).toBe(1);
            const own = await t.http
                .get(`${t.prefix}/archives?organization_id=${organization.id}&type=news`)
                .set('Authorization', bearer);
            expect(own.body.meta.total).toBe(1);
        });

        it('ties a snapshot to a service only of the same organization', async () => {
            const service = await fx.service(organization.id);
            const foreign = await fx.service((await fx.organization()).id);
            const create = (body: Record<string, unknown>) =>
                t.http
                    .post(`${t.prefix}/archives`)
                    .set('Authorization', bearer)
                    .send({ organization_id: organization.id, type: 'service', data: { x: 1 }, ...body });

            const tied = await create({ service_id: service.id });
            expect(tied.status).toBe(201);
            expect(tied.body.data.service_id).toBe(service.id);
            expectError(await create({ service_id: foreign.id }), 422, 'ARCHIVE_SERVICE_MISMATCH');
            expectError(
                await create({ service_id: new Types.ObjectId().toHexString() }),
                404,
                'SERVICE_NOT_FOUND',
            );
            expectError(await create({ data: { blob: 'x'.repeat(70 * 1024) } }), 400, 'VALIDATION_ERROR');
        });

        it('answers 404 for an unknown snapshot and lets a super-admin read any', async () => {
            const stored = await archive((await fx.organization()).id);

            expectError(
                await t.http
                    .get(`${t.prefix}/archives/${new Types.ObjectId().toHexString()}`)
                    .set('Authorization', bearer),
                404,
                'ARCHIVE_NOT_FOUND',
            );
            const read = await t.http
                .get(`${t.prefix}/archives/${stored._id.toHexString()}`)
                .set('Authorization', await fx.bearer(await fx.superAdmin()));
            expect(read.status).toBe(200);
            expect(read.body.data.data).toEqual({ label: 'news' });
        });
    });
});
