import { Types } from 'mongoose';
import sharp from 'sharp';

import { NewsExpiryJob } from '../../src/jobs/news-expiry.job';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('conditional reads of the organization tree (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;

    const tree = (headers: Record<string, string> = {}, query = '') => {
        const request = t.http.get(`${t.prefix}/organizations/${organization.id}${query}`);

        for (const [name, value] of Object.entries(headers)) request.set(name, value);

        return request;
    };

    const tag = async (): Promise<string> => {
        const res = await tree();
        expect(res.status).toBe(200);

        return res.headers['etag'] as string;
    };

    const changes = async (write: () => Promise<{ status: number }>, status = 200): Promise<void> => {
        const before = await tag();
        expect((await write()).status).toBe(status);

        const after = await tag();
        expect(after).not.toBe(before);
        expect((await tree({ 'If-None-Match': before })).status).toBe(200);
        expect((await tree({ 'If-None-Match': after })).status).toBe(304);
    };

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
    });

    it('answers a matching If-None-Match with 304 before building the tree, and counts no view', async () => {
        const first = await tree();
        expect(first.status).toBe(200);
        expect(first.headers['etag']).toMatch(/^W\/"[\w-]+"$/);
        expect(first.headers['cache-control']).toBe('public, max-age=60, must-revalidate');

        const again = await tree({ 'If-None-Match': first.headers['etag'] as string });
        expect(again.status).toBe(304);
        expect(again.text).toBe('');
        expect(again.headers['etag']).toBe(first.headers['etag']);

        expect((await tree({ 'If-None-Match': 'W/"other"' })).status).toBe(200);
        expect(
            (await tree({ 'If-None-Match': first.headers['etag'] as string, 'Cache-Control': 'no-cache' }))
                .status,
        ).toBe(200);
        const views = () => fx.collection('AnalyticsEvent').countDocuments({ type: 'organization.viewed' });
        await waitFor(async () => (await views()) >= 3);
        expect(await views()).toBe(3);
    });

    it('gives each sparse field set its own tag', async () => {
        const full = await tree();
        const sparse = await tree({}, '?fields=main_label');

        expect(sparse.headers['etag']).not.toBe(full.headers['etag']);
        expect(
            (await tree({ 'If-None-Match': full.headers['etag'] as string }, '?fields=main_label')).status,
        ).toBe(200);
    });

    it('keeps the version tag away from signed-in viewers and unknown organizations', async () => {
        const anonymous = await tree();
        const signed = await t.http
            .get(`${t.prefix}/organizations/${organization.id}`)
            .set('Authorization', adminBearer)
            .set('If-None-Match', anonymous.headers['etag'] as string);

        expect(signed.status).toBe(200);
        expect(signed.headers['cache-control']).toBe('private, no-store, max-age=0');
        expectError(await t.http.get(`${t.prefix}/organizations/64b000000000000000000000`), 404);
    });

    it('moves the tag on every write to the organization or anything nested in it', async () => {
        await changes(() =>
            t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', adminBearer)
                .send({ main_label: 'Renamed' }),
        );

        let newsId = '';
        await changes(async () => {
            const res = await t.http
                .post(`${t.prefix}/news`)
                .set('Authorization', adminBearer)
                .send({ organization_id: organization.id, label: 'Opening', enabled: true });
            newsId = res.body.data.id as string;

            return res;
        }, 201);
        await changes(() =>
            t.http
                .patch(`${t.prefix}/news/${newsId}`)
                .set('Authorization', adminBearer)
                .send({ label: 'Opened' }),
        );
        const second = await fx.news(organization.id);
        await changes(
            () =>
                t.http
                    .patch(`${t.prefix}/organizations/${organization.id}/news/order`)
                    .set('Authorization', adminBearer)
                    .send({ ids: [second.id, newsId] }),
            204,
        );
        await changes(
            () => t.http.delete(`${t.prefix}/news/${newsId}`).set('Authorization', adminBearer),
            204,
        );

        await changes(
            () =>
                t.http
                    .post(`${t.prefix}/infosections`)
                    .set('Authorization', adminBearer)
                    .send({
                        organization_id: organization.id,
                        label: 'Hours',
                        control: 'text',
                        value: { text_value: 'Always open' },
                    }),
            201,
        );

        let categoryId = '';
        await changes(async () => {
            const res = await t.http
                .post(`${t.prefix}/categories`)
                .set('Authorization', adminBearer)
                .send({ organization_id: organization.id, label: 'Documents', enabled: true });
            categoryId = res.body.data.id as string;

            return res;
        }, 201);

        let serviceId = '';
        await changes(async () => {
            const res = await t.http.post(`${t.prefix}/services`).set('Authorization', adminBearer).send({
                organization_id: organization.id,
                category_id: categoryId,
                label: 'Passport',
                status: 'published',
            });
            serviceId = res.body.data.id as string;

            return res;
        }, 201);
        await changes(() =>
            t.http
                .patch(`${t.prefix}/services/${serviceId}`)
                .set('Authorization', adminBearer)
                .send({ price: 10 }),
        );
        await changes(
            () =>
                t.http
                    .post(`${t.prefix}/services/${serviceId}/options`)
                    .set('Authorization', adminBearer)
                    .send({ label: 'Desk' }),
            201,
        );
        await changes(
            () => t.http.delete(`${t.prefix}/services/${serviceId}`).set('Authorization', adminBearer),
            204,
        );
        await changes(() =>
            t.http.post(`${t.prefix}/services/${serviceId}/restore`).set('Authorization', adminBearer),
        );
        await changes(
            () => t.http.delete(`${t.prefix}/categories/${categoryId}`).set('Authorization', adminBearer),
            204,
        );

        const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#445566' } })
            .jpeg()
            .toBuffer();
        let imageId = '';
        await changes(async () => {
            const res = await t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', adminBearer)
                .attach('file', image, { filename: 'photo.jpg', contentType: 'image/jpeg' });
            imageId = res.body.data.id as string;

            return res;
        }, 201);
        await changes(
            () => t.http.delete(`${t.prefix}/images/${imageId}`).set('Authorization', adminBearer),
            204,
        );
    });

    it('moves the tag when a job removes expired news', async () => {
        await fx.news(organization.id, { expires_at: new Date(Date.now() - 60_000) });

        await changes(async () => {
            expect(await t.app.get(NewsExpiryJob).execute(new Date())).toEqual({ archived: 1 });

            return { status: 200 };
        });
    });

    it('leaves the tag alone when a booking changes nothing the tree shows', async () => {
        const option = fx.bookableOption();
        const service = await fx.service(organization.id, { options: [option] });
        const before = await tag();

        const client = await fx.bearer(await fx.client());
        expect(
            (
                await t.http
                    .post(`${t.prefix}/services/${service.id}/bookings`)
                    .set('Authorization', client)
                    .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' })
            ).status,
        ).toBe(201);
        expect(await tag()).toBe(before);
    });

    it('keeps scheduled news out of the public tree until publish_at, then moves the tag without a write', async () => {
        const released = await fx.news(organization.id, {
            label: 'Released',
            publish_at: new Date(Date.now() - 60_000),
        });
        const scheduled = await fx.news(organization.id, {
            label: 'Scheduled',
            publish_at: new Date(Date.now() + 3_600_000),
        });
        const ids = (res: { body: { data: { news: { id: string }[] } } }) =>
            res.body.data.news.map((item) => item.id);

        const before = await tree();
        expect(ids(before)).toEqual([released.id]);

        const own = await t.http
            .get(`${t.prefix}/organizations/${organization.id}`)
            .set('Authorization', adminBearer);
        expect(ids(own)).toEqual(expect.arrayContaining([released.id, scheduled.id]));

        const listed = await t.http.get(`${t.prefix}/organizations?include=news`);
        const row = listed.body.data.find((item: { id: string }) => item.id === organization.id);
        expect(row.counts.news).toBe(1);
        expect(row.news.map((item: { id: string }) => item.id)).toEqual([released.id]);

        await fx
            .collection('News')
            .collection.updateOne(
                { _id: new Types.ObjectId(scheduled.id) },
                { $set: { publish_at: new Date(Date.now() - 1_000) } },
            );

        const after = await tree({ 'If-None-Match': before.headers['etag'] as string });
        expect(after.status).toBe(200);
        expect(after.headers['etag']).not.toBe(before.headers['etag']);
        expect(ids(after)).toEqual(expect.arrayContaining([released.id, scheduled.id]));
    });
});
