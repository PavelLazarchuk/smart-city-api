import { Types } from 'mongoose';

import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('service editing and trash (e2e)', () => {
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

    const patch = (id: string, body: Record<string, unknown>, token = bearer) =>
        t.http.patch(`${t.prefix}/services/${id}`).set('Authorization', token).send(body);

    const revisions = (id: string) =>
        fx.collection('ServiceRevision').countDocuments({ service_id: new Types.ObjectId(id) });

    describe('update', () => {
        it('moves a service into a category at its end and back out to the top level', async () => {
            const category = await fx.category(organization.id);
            await fx.service(organization.id, { category_id: category.id, position: 7 });
            const service = await fx.service(organization.id, { position: 3 });

            const moved = await patch(service.id, { category_id: category.id });
            expect(moved.status).toBe(200);
            expect(moved.body.data.category_id).toBe(category.id);
            expect(moved.body.data.position).toBe(8);

            const same = await patch(service.id, { category_id: category.id });
            expect(same.body.data.position).toBe(8);

            const out = await patch(service.id, { category_id: null });
            expect(out.body.data.category_id).toBeNull();

            const foreign = await fx.category((await fx.organization()).id);
            expectError(
                await patch(service.id, { category_id: foreign.id }),
                422,
                'CATEGORY_ORGANIZATION_MISMATCH',
            );
        });

        it('derives the status from enabled and stamps the first publication only', async () => {
            const service = await fx.service(organization.id, {
                status: 'draft',
                enabled: false,
                published_at: undefined,
            });

            const published = await patch(service.id, { enabled: true });
            expect(published.body.data).toMatchObject({ status: 'published', enabled: true });
            const firstPublished = published.body.data.published_at as string;
            expect(firstPublished).toEqual(expect.any(String));

            const hidden = await patch(service.id, { enabled: false });
            expect(hidden.body.data).toMatchObject({ status: 'draft', enabled: false });

            const archived = await patch(service.id, { status: 'archived' });
            expect(archived.body.data).toMatchObject({ status: 'archived', enabled: false });
            expect((await patch(service.id, { enabled: false })).body.data.status).toBe('archived');

            const again = await t.http
                .put(`${t.prefix}/services/${service.id}/status`)
                .set('Authorization', bearer)
                .send({ status: 'published' });
            expect(again.status).toBe(200);
            expect(again.body.data.published_at).toBe(firstPublished);
        });

        it('clears the location and the price and fills the default currency with a new price', async () => {
            const service = await fx.service(organization.id);

            const placed = await patch(service.id, {
                location: { lng: 13.4, lat: 52.5 },
                price: 20,
                address: 'Main 1',
                tags: ['a', 'a', 'b'],
            });
            expect(placed.body.data).toMatchObject({
                location: { type: 'Point', coordinates: [13.4, 52.5] },
                price: 20,
                currency: expect.any(String),
                address: 'Main 1',
                tags: ['a', 'b'],
            });

            const cleared = await patch(service.id, { location: null, price: null });
            expect(cleared.body.data.location).toBeUndefined();
            expect(cleared.body.data.price ?? null).toBeNull();
        });

        it('writes a revision only when something changed', async () => {
            const service = await fx.service(organization.id, { label: 'Original' });

            expect((await patch(service.id, {})).status).toBe(200);
            expect(await revisions(service.id)).toBe(0);

            expect((await patch(service.id, { label: 'Changed' })).status).toBe(200);
            expect(await revisions(service.id)).toBe(1);

            const history = await t.http
                .get(`${t.prefix}/services/${service.id}/history`)
                .set('Authorization', bearer);
            expect(history.body.data).toHaveLength(1);
            expect(history.body.data[0].action).toBe('update');
        });

        it('refuses a deleted service and a slug another service holds', async () => {
            await fx.service(organization.id, { slug: 'taken' });
            const service = await fx.service(organization.id);
            const deleted = await fx.service(organization.id, { deleted_at: new Date() });

            expectError(await patch(service.id, { slug: 'taken' }), 409, 'SERVICE_SLUG_TAKEN');
            expectError(await patch(deleted.id, { label: 'x' }), 404, 'SERVICE_NOT_FOUND');
        });
    });

    describe('delete and restore', () => {
        const remove = (id: string, query = '', token = bearer) =>
            t.http.delete(`${t.prefix}/services/${id}${query}`).set('Authorization', token);
        const restore = (id: string, token = bearer) =>
            t.http.post(`${t.prefix}/services/${id}/restore`).set('Authorization', token);

        it('answers 404 to a second soft delete and 422 to restoring a live service', async () => {
            const service = await fx.service(organization.id);

            expectError(await restore(service.id), 422, 'SERVICE_NOT_DELETED');
            expect((await remove(service.id)).status).toBe(204);
            expectError(await remove(service.id), 404, 'SERVICE_NOT_FOUND');
            expect((await restore(service.id)).status).toBe(200);
            expect(await revisions(service.id)).toBe(2);
        });

        it('leaves a permanent delete to super-admins and purges the service with its slots', async () => {
            const option = fx.bookableOption();
            const service = await fx.service(organization.id, { options: [option] });

            expectError(await remove(service.id, '?permanent=true'), 403, 'FORBIDDEN');
            const superBearer = await fx.bearer(await fx.superAdmin());
            expect((await remove(service.id, '?permanent=true', superBearer)).status).toBe(204);
            expect(
                await fx.collection('Service').countDocuments({ _id: new Types.ObjectId(service.id) }),
            ).toBe(0);
            expect(
                await fx.collection('Slot').countDocuments({ service_id: new Types.ObjectId(service.id) }),
            ).toBe(0);
            expectError(await remove(service.id, '?permanent=true', superBearer), 404);
        });

        it('lists the trash of the organization to its staff and everything to a super-admin', async () => {
            const own = await fx.service(organization.id, { deleted_at: new Date() });
            const foreign = await fx.service((await fx.organization()).id, { deleted_at: new Date() });
            await fx.service(organization.id);

            const mine = await t.http.get(`${t.prefix}/services?deleted=true`).set('Authorization', bearer);
            expect(mine.body.data.map((row: { id: string }) => row.id)).toEqual([own.id]);

            const all = await t.http
                .get(`${t.prefix}/services?deleted=true`)
                .set('Authorization', await fx.bearer(await fx.superAdmin()));
            expect(all.body.data.map((row: { id: string }) => row.id).sort()).toEqual(
                [own.id, foreign.id].sort(),
            );
        });

        it('answers 404 for the history of an unknown service', async () => {
            expectError(
                await t.http
                    .get(`${t.prefix}/services/${new Types.ObjectId().toHexString()}/history`)
                    .set('Authorization', await fx.bearer(await fx.superAdmin())),
                404,
            );
        });
    });

    describe('list', () => {
        it('embeds the organization and category of each row on request', async () => {
            const category = await fx.category(organization.id, { label: 'Clinic' });
            await fx.service(organization.id, { category_id: category.id, label: 'Inside' });
            await fx.service(organization.id, { label: 'Outside' });

            const res = await t.http.get(
                `${t.prefix}/services?organization_id=${organization.id}&include=organization,category`,
            );
            expect(res.status).toBe(200);
            const byLabel = new Map(res.body.data.map((row: { label: string }) => [row.label, row]));
            expect(byLabel.get('Inside')).toMatchObject({
                organization: { id: organization.id },
                category: { id: category.id, label: 'Clinic' },
            });
            expect((byLabel.get('Outside') as { category: unknown }).category).toBeNull();
        });

        it('filters by enabled for the staff of the organization', async () => {
            const draft = await fx.service(organization.id, { status: 'draft', enabled: false });
            await fx.service(organization.id);

            const drafts = await t.http
                .get(`${t.prefix}/services?organization_id=${organization.id}&enabled=false`)
                .set('Authorization', bearer);
            expect(drafts.body.data.map((row: { id: string }) => row.id)).toEqual([draft.id]);
        });
    });
});
