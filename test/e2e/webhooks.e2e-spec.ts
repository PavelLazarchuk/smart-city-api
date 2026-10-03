import { Types } from 'mongoose';

import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('webhooks (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let other: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let superBearer: string;
    let clientBearer: string;

    const url = 'http://127.0.0.1:9/hook';
    const create = (body: Record<string, unknown>, token = adminBearer) =>
        t.http
            .post(`${t.prefix}/webhooks`)
            .set('Authorization', token)
            .send({ url, events: ['booking.created'], ...body });
    const get = (path: string, token = adminBearer) =>
        t.http.get(`${t.prefix}${path}`).set('Authorization', token);

    async function failedEvent(organizationId: string | null, deliveries: Record<string, unknown>[] = []) {
        const id = new Types.ObjectId().toHexString();

        await fx.collection('OutboxEvent').create({
            id,
            type: 'booking.created',
            organization_id: organizationId ? new Types.ObjectId(organizationId) : null,
            status: 'failed',
            attempts: 5,
            last_error: 'HTTP 500',
            next_attempt_at: new Date(Date.now() + 3_600_000),
            deliveries,
        });

        return id;
    }

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        other = await fx.organization();
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
        superBearer = await fx.bearer(await fx.superAdmin());
        clientBearer = await fx.bearer(await fx.client());
    });

    it('keeps the endpoints away from clients', async () => {
        expectError(await get('/webhooks', clientBearer), 403);
        expectError(await get('/outbox/events', clientBearer), 403);
        expect((await t.http.get(`${t.prefix}/webhooks`)).status).toBe(401);
    });

    describe('create', () => {
        it('stores a hook of the admin organization, shows the secret once and sets Location', async () => {
            const res = await create({ organization_id: organization.id, description: 'CRM' });

            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({
                organization_id: organization.id,
                url,
                events: ['booking.created'],
                enabled: true,
                description: 'CRM',
                consecutive_failures: 0,
            });
            expect(res.body.data.secret).toMatch(/^whsec_/);
            expect(res.headers['location']).toBe(`/webhooks/${res.body.data.id as string}`);

            const shown = await get(`/webhooks/${res.body.data.id as string}`);
            expect(shown.body.data.secret).toBeUndefined();
        });

        it('lets only a super admin create a global hook', async () => {
            expectError(await create({}), 403);
            expectError(await create({ organization_id: other.id }), 403);

            const res = await create({}, superBearer);
            expect(res.status).toBe(201);
            expect(res.body.data.organization_id).toBeNull();
        });

        it('rejects a missing organization, bad events and a bad url', async () => {
            expectError(
                await create({ organization_id: new Types.ObjectId().toHexString() }, superBearer),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
            expectError(
                await create({ organization_id: organization.id, events: [] }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(
                await create({ organization_id: organization.id, events: ['nope'] }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(
                await create({ organization_id: organization.id, url: 'ftp://x/y' }),
                400,
                'VALIDATION_ERROR',
            );
        });
    });

    describe('read and scope', () => {
        it('lists only the hooks of the admin organizations and filters a super admin by organization', async () => {
            await create({ organization_id: organization.id });
            await create({ organization_id: other.id }, superBearer);
            await create({}, superBearer);

            const own = await get('/webhooks');
            expect(own.body.meta.total).toBe(1);
            expect(own.body.data[0].organization_id).toBe(organization.id);

            expect((await get('/webhooks', superBearer)).body.meta.total).toBe(3);
            expect((await get(`/webhooks?organization_id=${other.id}`, superBearer)).body.meta.total).toBe(1);
            expectError(await get(`/webhooks?organization_id=${other.id}`), 403);
        });

        it('answers 404 for a missing hook and for one of another organization', async () => {
            const foreign = await create({ organization_id: other.id }, superBearer);
            const id = foreign.body.data.id as string;

            expectError(await get(`/webhooks/${id}`), 404, 'WEBHOOK_NOT_FOUND');
            expectError(
                await get(`/webhooks/${new Types.ObjectId().toHexString()}`),
                404,
                'WEBHOOK_NOT_FOUND',
            );
            expectError(
                await t.http.patch(`${t.prefix}/webhooks/${id}`).set('Authorization', adminBearer).send({}),
                404,
                'WEBHOOK_NOT_FOUND',
            );
            expectError(
                await t.http.delete(`${t.prefix}/webhooks/${id}`).set('Authorization', adminBearer),
                404,
                'WEBHOOK_NOT_FOUND',
            );
            expectError(
                await t.http
                    .post(`${t.prefix}/webhooks/${id}/rotate-secret`)
                    .set('Authorization', adminBearer),
                404,
                'WEBHOOK_NOT_FOUND',
            );
            expectError(
                await t.http.post(`${t.prefix}/webhooks/${id}/test`).set('Authorization', adminBearer),
                404,
                'WEBHOOK_NOT_FOUND',
            );
            expect((await get(`/webhooks/${id}`, superBearer)).status).toBe(200);
        });
    });

    describe('update', () => {
        it('changes fields, clears the description with null and resets failures when re-enabled', async () => {
            const created = await create({ organization_id: organization.id, description: 'old' });
            const id = created.body.data.id as string;
            await fx
                .collection('Webhook')
                .updateOne(
                    { _id: new Types.ObjectId(id) },
                    { $set: { consecutive_failures: 4, enabled: false } },
                );

            const patch = (body: Record<string, unknown>) =>
                t.http.patch(`${t.prefix}/webhooks/${id}`).set('Authorization', adminBearer).send(body);

            const res = await patch({
                url: 'http://127.0.0.1:9/other',
                events: ['booking.cancelled', 'booking.rescheduled'],
                enabled: true,
                description: null,
            });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                url: 'http://127.0.0.1:9/other',
                events: ['booking.cancelled', 'booking.rescheduled'],
                enabled: true,
                consecutive_failures: 0,
            });
            expect(res.body.data.description).toBeUndefined();

            const same = await patch({});
            expect(same.status).toBe(200);
            expect(same.body.data.url).toBe('http://127.0.0.1:9/other');

            expect((await patch({ description: 'new' })).body.data.description).toBe('new');
            expectError(await patch({ url: 'ftp://x/y' }), 400, 'VALIDATION_ERROR');
            expectError(await patch({ events: [] }), 400, 'VALIDATION_ERROR');
        });
    });

    describe('rotate, test and delete', () => {
        it('issues a new secret that replaces the old one', async () => {
            const created = await create({ organization_id: organization.id });
            const id = created.body.data.id as string;

            const rotated = await t.http
                .post(`${t.prefix}/webhooks/${id}/rotate-secret`)
                .set('Authorization', adminBearer);
            expect(rotated.status).toBe(200);
            expect(rotated.body.data.secret).toMatch(/^whsec_/);
            expect(rotated.body.data.secret).not.toBe(created.body.data.secret);

            const stored = await fx
                .collection<{ secret: string }>('Webhook')
                .findById(id)
                .select('+secret')
                .lean();
            expect(stored!.secret).toBe(rotated.body.data.secret);
        });

        it('queues a test event for exactly that hook', async () => {
            const created = await create({ organization_id: organization.id });
            const id = created.body.data.id as string;

            const res = await t.http
                .post(`${t.prefix}/webhooks/${id}/test`)
                .set('Authorization', adminBearer);
            expect(res.status).toBe(202);
            expect(res.body.data.queued).toBe(true);

            const event = await fx
                .collection<{
                    type: string;
                    organization_id: Types.ObjectId;
                    only_webhook_id: Types.ObjectId;
                }>('OutboxEvent')
                .findOne({ id: res.body.data.event_id as string })
                .lean();
            expect(event).toMatchObject({ type: 'webhook.test' });
            expect(event!.only_webhook_id.toHexString()).toBe(id);
            expect(event!.organization_id.toHexString()).toBe(organization.id);
        });

        it('deletes a hook', async () => {
            const created = await create({ organization_id: organization.id });
            const id = created.body.data.id as string;

            const res = await t.http.delete(`${t.prefix}/webhooks/${id}`).set('Authorization', adminBearer);
            expect(res.status).toBe(204);
            expectError(await get(`/webhooks/${id}`), 404, 'WEBHOOK_NOT_FOUND');
        });
    });

    describe('outbox events', () => {
        it('lists events of the admin organizations with filters and hides the others', async () => {
            await failedEvent(organization.id);
            await failedEvent(other.id);
            await failedEvent(null);

            const own = await get('/outbox/events');
            expect(own.body.meta.total).toBe(1);
            expect(own.body.data[0]).toMatchObject({
                type: 'booking.created',
                status: 'failed',
                organization_id: organization.id,
                attempts: 5,
                last_error: 'HTTP 500',
            });
            expect(own.body.data[0].trace_id).toBeNull();

            expect((await get('/outbox/events', superBearer)).body.meta.total).toBe(3);
            expect(
                (await get(`/outbox/events?organization_id=${other.id}`, superBearer)).body.meta.total,
            ).toBe(1);
            expect((await get('/outbox/events?status=pending', superBearer)).body.meta.total).toBe(0);
            expect((await get('/outbox/events?type=booking.cancelled', superBearer)).body.meta.total).toBe(0);
            expect((await get('/outbox/events?type=booking.created', superBearer)).body.meta.total).toBe(3);
            expectError(await get(`/outbox/events?organization_id=${other.id}`), 403);
            expectError(await get('/outbox/events?type=nope', superBearer), 400, 'VALIDATION_ERROR');
        });

        it('replays a failed event, keeping the delivered targets as they are', async () => {
            const id = await failedEvent(organization.id, [
                { target: 'webhook:a', status: 'delivered', attempts: 1 },
                { target: 'webhook:b', status: 'failed', attempts: 5 },
            ]);

            const res = await t.http
                .post(`${t.prefix}/outbox/events/${id}/replay`)
                .set('Authorization', adminBearer);
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ id, status: 'pending', attempts: 0 });
            expect(
                res.body.data.deliveries.map((d: { target: string; status: string }) => [d.target, d.status]),
            ).toEqual([
                ['webhook:a', 'delivered'],
                ['webhook:b', 'pending'],
            ]);
        });

        it('replays only failed events of an accessible organization', async () => {
            const foreign = await failedEvent(other.id);
            const global = await failedEvent(null);
            const pending = new Types.ObjectId().toHexString();
            await fx.collection('OutboxEvent').create({
                id: pending,
                type: 'booking.created',
                organization_id: new Types.ObjectId(organization.id),
                status: 'pending',
            });
            const replay = (id: string, token = adminBearer) =>
                t.http.post(`${t.prefix}/outbox/events/${id}/replay`).set('Authorization', token);

            expectError(await replay(foreign), 404, 'NOT_FOUND');
            expectError(await replay(global), 404, 'NOT_FOUND');
            expectError(await replay(new Types.ObjectId().toHexString()), 404, 'NOT_FOUND');
            expectError(await replay(pending), 409, 'CONFLICT');
            expect((await replay(foreign, superBearer)).status).toBe(200);
        });
    });
});
