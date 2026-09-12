import { readFileSync } from 'node:fs';
import { Types } from 'mongoose';

import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

describe('images, archives, sms, analytics (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let superAdmin: FixtureUser;
    let admin: FixtureUser;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        superAdmin = await fx.superAdmin();
        admin = await fx.admin([organization.id]);
    });

    describe('images', () => {
        it('uploads through the storage provider, lists, and deletes the file after commit', async () => {
            const bearer = await fx.bearer(admin);
            const uploaded = await t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', bearer)
                .attach('file', PNG, { filename: 'pixel.png', contentType: 'image/png' });
            expect(uploaded.status).toBe(201);
            expect(uploaded.body.data.mime_type).toBe('image/png');
            expect(uploaded.body.data.src).toMatch(/^http:\/\/localhost:8080\/uploads\//);
            const storedPath = `${t.config.storage.local.dir}/${uploaded.body.data.name as string}`;
            expect(readFileSync(storedPath)).toHaveLength(PNG.length);

            const wrongType = await t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', bearer)
                .attach('file', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' });
            expectError(wrongType, 400, 'FILE_TYPE_NOT_ALLOWED');
            expectError(
                await t.http
                    .post(`${t.prefix}/organizations/${organization.id}/images`)
                    .set('Authorization', bearer),
                400,
                'FILE_REQUIRED',
            );

            const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));
            expectError(
                await t.http
                    .post(`${t.prefix}/organizations/${organization.id}/images`)
                    .set('Authorization', foreign)
                    .attach('file', PNG, 'p.png'),
                403,
            );

            const listed = await t.http.get(`${t.prefix}/organizations/${organization.id}/images`);
            expect(listed.body.data).toHaveLength(1);
            expectError(await t.http.get(`${t.prefix}/images`).set('Authorization', bearer), 403);
            expect(
                (await t.http.get(`${t.prefix}/images`).set('Authorization', await fx.bearer(superAdmin)))
                    .body.meta.total,
            ).toBe(1);

            expectError(
                await t.http
                    .delete(`${t.prefix}/images/${uploaded.body.data.id as string}`)
                    .set('Authorization', foreign),
                403,
            );
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/images/${uploaded.body.data.id as string}`)
                        .set('Authorization', bearer)
                ).status,
            ).toBe(204);
            expect(() => readFileSync(storedPath)).toThrow();
        });

        it('refuses a file whose bytes do not match the declared type, and names it from that type', async () => {
            const bearer = await fx.bearer(admin);
            const disguised = await t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', bearer)
                .attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), {
                    filename: 'evil.svg',
                    contentType: 'image/png',
                });
            expectError(disguised, 400, 'FILE_TYPE_NOT_ALLOWED');

            const honest = await t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', bearer)
                .attach('file', PNG, { filename: 'pixel.svg', contentType: 'image/png' });
            expect(honest.status).toBe(201);
            expect(honest.body.data.name as string).toMatch(/\.png$/);
        });
    });

    describe('archives', () => {
        it('scopes admins to their organizations and gives super-admins everything', async () => {
            const other = await fx.organization();
            await fx.collection('Archive').create({
                organization_id: new Types.ObjectId(organization.id),
                type: 'news',
                data: { a: 1 },
            });
            await fx
                .collection('Archive')
                .create({ organization_id: new Types.ObjectId(other.id), type: 'service', data: { b: 2 } });
            const bearer = await fx.bearer(admin);

            const mine = await t.http.get(`${t.prefix}/archives`).set('Authorization', bearer);
            expect(mine.body.meta.total).toBe(1);
            expect(mine.body.data[0].organization_id).toBe(organization.id);
            expectError(
                await t.http
                    .get(`${t.prefix}/archives?organization_id=${other.id}`)
                    .set('Authorization', bearer),
                403,
            );
            expect(
                (await t.http.get(`${t.prefix}/archives`).set('Authorization', await fx.bearer(superAdmin)))
                    .body.meta.total,
            ).toBe(2);
            expectError(
                await t.http
                    .get(`${t.prefix}/archives`)
                    .set('Authorization', await fx.bearer(await fx.citizen())),
                403,
            );

            const created = await t.http
                .post(`${t.prefix}/archives`)
                .set('Authorization', bearer)
                .send({ organization_id: organization.id, type: 'news', data: { label: 'old' } });
            expect(created.status).toBe(201);
            expectError(
                await t.http
                    .post(`${t.prefix}/archives`)
                    .set('Authorization', bearer)
                    .send({ organization_id: other.id, type: 'news', data: {} }),
                403,
            );
            const otherArchive = await fx
                .collection<{ _id: Types.ObjectId }>('Archive')
                .findOne({ organization_id: new Types.ObjectId(other.id) })
                .lean();
            expectError(
                await t.http
                    .get(`${t.prefix}/archives/${otherArchive!._id.toHexString()}`)
                    .set('Authorization', bearer),
                403,
            );
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/archives/${created.body.data.id as string}`)
                        .set('Authorization', bearer)
                ).status,
            ).toBe(204);
        });

        it('bounds the snapshot and checks that the service belongs to the organization', async () => {
            const bearer = await fx.bearer(admin);
            const other = await fx.organization();
            const foreignService = await fx.service(other.id);
            const ownService = await fx.service(organization.id);

            expectError(
                await t.http.post(`${t.prefix}/archives`).set('Authorization', bearer).send({
                    organization_id: organization.id,
                    service_id: foreignService.id,
                    type: 'service',
                    data: {},
                }),
                422,
                'ARCHIVE_SERVICE_MISMATCH',
            );
            expect(
                (
                    await t.http.post(`${t.prefix}/archives`).set('Authorization', bearer).send({
                        organization_id: organization.id,
                        service_id: ownService.id,
                        type: 'service',
                        data: {},
                    })
                ).status,
            ).toBe(201);
            expectError(
                await t.http
                    .post(`${t.prefix}/archives`)
                    .set('Authorization', bearer)
                    .send({
                        organization_id: organization.id,
                        type: 'news',
                        data: { blob: 'x'.repeat(70_000) },
                    }),
                400,
                'VALIDATION_ERROR',
            );
        });
    });

    describe('sms', () => {
        it('logs every send, reports by period, and the test endpoint is a POST for super-admins', async () => {
            const spy = jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockResolvedValue(undefined);
            const bearer = await fx.bearer(superAdmin);
            expectError(
                await t.http
                    .post(`${t.prefix}/sms/test`)
                    .set('Authorization', await fx.bearer(admin))
                    .send({ phone: '375291112233' }),
                403,
            );
            const sent = await t.http
                .post(`${t.prefix}/sms/test`)
                .set('Authorization', bearer)
                .send({ phone: '375291112233' });
            expect(sent.status).toBe(200);
            expect(sent.body.data).toEqual({ phone: '375291112233', status: 'sent' });
            expect(spy).toHaveBeenCalledTimes(1);

            spy.mockRejectedValueOnce(new Error('smpp down'));
            expectError(
                await t.http
                    .post(`${t.prefix}/sms/test`)
                    .set('Authorization', bearer)
                    .send({ phone: '375291112233' }),
                422,
                'SMS_DELIVERY_FAILED',
            );

            const list = await t.http.get(`${t.prefix}/sms?period=this_month`).set('Authorization', bearer);
            expect(list.status).toBe(200);
            expect(list.body.data).toHaveLength(2);
            expect(list.body.data.map((row: { status: string }) => row.status).sort()).toEqual([
                'failed',
                'sent',
            ]);
            expect(list.body.meta.next_cursor).toBeNull();

            // A cursor page does not count the whole match unless asked to.
            expect(list.body.meta.summary.total).toBeNull();
            expect(list.body.meta.total).toBeNull();
            expect(list.body.meta.total_pages).toBeNull();
            const counted = await t.http
                .get(`${t.prefix}/sms?period=this_month&with_total=true`)
                .set('Authorization', bearer);
            expect(counted.body.meta.summary.total).toBe(2);
            expect(counted.body.meta.total).toBe(2);
            const offset = await t.http
                .get(`${t.prefix}/sms?period=this_month&mode=page`)
                .set('Authorization', bearer);
            expect(offset.body.meta.total).toBe(2);

            const paged = await t.http.get(`${t.prefix}/sms?limit=1`).set('Authorization', bearer);
            expect(paged.body.data).toHaveLength(1);
            expect(typeof paged.body.meta.next_cursor).toBe('string');
            const next = await t.http
                .get(`${t.prefix}/sms?limit=1&cursor=${paged.body.meta.next_cursor as string}`)
                .set('Authorization', bearer);
            expect(next.body.data).toHaveLength(1);
            expect(next.body.data[0].id).not.toBe(paged.body.data[0].id);
            expect(next.body.meta.next_cursor).toBeNull();
            spy.mockRestore();
        });
    });

    describe('analytics', () => {
        it('is super-admin only and lists recorded events with filters', async () => {
            await t.http
                .get(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', await fx.bearer(admin));
            await t.http.get(`${t.prefix}/organizations`);
            await waitFor(async () => (await fx.collection('AnalyticsEvent').countDocuments({})) >= 2);
            expectError(
                await t.http.get(`${t.prefix}/analytics/events`).set('Authorization', await fx.bearer(admin)),
                403,
            );
            const all = await t.http
                .get(`${t.prefix}/analytics/events?with_total=true`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(all.status).toBe(200);
            expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
            const viewed = await t.http
                .get(`${t.prefix}/analytics/events?type=organization.viewed`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(viewed.body.data).toHaveLength(1);
            expect(viewed.body.data[0]).toMatchObject({
                organization_id: organization.id,
                user_id: admin.id,
                user_role: 'common-admin',
            });
            expect(typeof viewed.body.data[0].request_id).toBe('string');
        });
    });
});
