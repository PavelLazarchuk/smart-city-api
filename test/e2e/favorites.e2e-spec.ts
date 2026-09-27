import { Types } from 'mongoose';

import { FAVORITES_MAX_PER_USER } from '../../src/common/config/constants';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('favorites (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string; main_label: string };
    let client: FixtureUser;
    let bearer: string;

    const put = (type: string, id: string, token = bearer) =>
        t.http.put(`${t.prefix}/me/favorites/${type}/${id}`).set('Authorization', token);
    const list = (query = '', token = bearer) =>
        t.http.get(`${t.prefix}/me/favorites${query}`).set('Authorization', token);

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        client = await fx.client();
        bearer = await fx.bearer(client);
    });

    it('adds services and organizations once, lists them newest first and removes them', async () => {
        const service = await fx.service(organization.id, { options: [fx.bookableOption()] });

        expect((await put('service', service.id)).status).toBe(204);
        expect((await put('service', service.id)).status).toBe(204);
        expect((await put('organization', organization.id)).status).toBe(204);

        const all = await list();
        expect(all.status).toBe(200);
        expect(all.body.meta.total).toBe(2);
        expect(all.body.data.map((item: { type: string }) => item.type)).toEqual(['organization', 'service']);
        expect(all.body.data[0]).toMatchObject({
            id: organization.id,
            organization_id: organization.id,
            available: true,
            organization: { id: organization.id, main_label: organization.main_label },
        });
        expect(all.body.data[1]).toMatchObject({
            id: service.id,
            organization_id: organization.id,
            available: true,
            service: { id: service.id, options_count: 1 },
        });
        expect(all.body.data[1].service.options).toBeUndefined();

        const services = await list('?type=service');
        expect(services.body.data).toHaveLength(1);

        const removed = await t.http
            .delete(`${t.prefix}/me/favorites/service/${service.id}`)
            .set('Authorization', bearer);
        expect(removed.status).toBe(204);
        expect(
            (
                await t.http
                    .delete(`${t.prefix}/me/favorites/service/${service.id}`)
                    .set('Authorization', bearer)
            ).status,
        ).toBe(204);
        expect((await list('?type=service')).body.data).toHaveLength(0);
    });

    it('keeps each list private to its owner', async () => {
        await put('organization', organization.id);
        const other = await fx.bearer(await fx.client());

        expect((await list('', other)).body.data).toHaveLength(0);
        expectError(await t.http.get(`${t.prefix}/me/favorites`), 401);
    });

    it('refuses what the caller cannot see or what does not exist', async () => {
        const draft = await fx.service(organization.id, { status: 'draft', enabled: false });

        expectError(await put('service', draft.id), 404, 'SERVICE_NOT_FOUND');
        expectError(await put('service', new Types.ObjectId().toHexString()), 404, 'SERVICE_NOT_FOUND');
        expectError(
            await put('organization', new Types.ObjectId().toHexString()),
            404,
            'ORGANIZATION_NOT_FOUND',
        );
        expectError(await put('news', organization.id), 400, 'VALIDATION_ERROR');
        expectError(await put('service', 'not-an-id'), 400, 'VALIDATION_ERROR');

        const admin = await fx.bearer(await fx.admin([organization.id]));
        expect((await put('service', draft.id, admin)).status).toBe(204);
    });

    it('marks a trashed service unavailable and brings it back on restore', async () => {
        const service = await fx.service(organization.id);
        const admin = await fx.bearer(await fx.admin([organization.id]));
        await put('service', service.id);

        expect(
            (await t.http.delete(`${t.prefix}/services/${service.id}`).set('Authorization', admin)).status,
        ).toBe(204);
        const trashed = await list();
        expect(trashed.body.data[0]).toMatchObject({ id: service.id, available: false, service: null });

        expect(
            (await t.http.post(`${t.prefix}/services/${service.id}/restore`).set('Authorization', admin))
                .status,
        ).toBe(200);
        expect((await list()).body.data[0]).toMatchObject({ id: service.id, available: true });
    });

    it('is cleaned up when the service, the organization or the account goes away', async () => {
        const favorites = fx.collection('Favorite');
        const superAdmin = await fx.bearer(await fx.superAdmin());
        const purged = await fx.service(organization.id);
        const kept = await fx.service(organization.id);
        await put('service', purged.id);
        await put('service', kept.id);
        await put('organization', organization.id);

        expect(
            (
                await t.http
                    .delete(`${t.prefix}/services/${purged.id}?permanent=true`)
                    .set('Authorization', superAdmin)
            ).status,
        ).toBe(204);
        expect(await favorites.countDocuments({ target_id: new Types.ObjectId(purged.id) })).toBe(0);
        expect(await favorites.countDocuments({})).toBe(2);

        const other = await fx.organization();
        await put('organization', other.id);
        expect(
            (
                await t.http
                    .delete(`${t.prefix}/organizations/${organization.id}`)
                    .set('Authorization', superAdmin)
            ).status,
        ).toBe(204);
        expect(await favorites.countDocuments({})).toBe(1);

        expect(
            (await t.http.delete(`${t.prefix}/users/${client.id}`).set('Authorization', bearer)).status,
        ).toBe(204);
        expect(await favorites.countDocuments({})).toBe(0);
    });

    it('caps how many favorites one account may keep', async () => {
        const services = await Promise.all([fx.service(organization.id), fx.service(organization.id)]);
        await fx.collection('Favorite').insertMany(
            Array.from({ length: FAVORITES_MAX_PER_USER - 1 }, () => ({
                user_id: new Types.ObjectId(client.id),
                type: 'organization',
                target_id: new Types.ObjectId(),
                organization_id: new Types.ObjectId(),
            })),
        );

        expect((await put('service', services[0].id)).status).toBe(204);
        expect((await put('service', services[0].id)).status).toBe(204);
        expectError(await put('service', services[1].id), 422, 'FAVORITES_LIMIT_REACHED');
    });
});
