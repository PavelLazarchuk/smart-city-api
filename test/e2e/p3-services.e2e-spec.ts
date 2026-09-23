import { Types } from 'mongoose';

import { RecurrentSlotsJob } from '../../src/jobs/recurrent-slots.job';
import { TrashPurgeJob } from '../../src/jobs/trash-purge.job';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('services catalogue (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let bearer: string;
    let superBearer: string;

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
        superBearer = await fx.bearer(await fx.superAdmin());
    });

    const create = (body: Record<string, unknown>, token = bearer) =>
        t.http
            .post(`${t.prefix}/services`)
            .set('Authorization', token)
            .send({ organization_id: organization.id, ...body });

    describe('slug and status', () => {
        it('generates a unique slug from the label, accepts an explicit one and refuses a taken one', async () => {
            const first = await create({ label: 'Приём терапевта', status: 'published' });
            expect(first.status).toBe(201);
            expect(first.body.data.slug).toBe('priyom-terapevta');

            const second = await create({ label: 'Приём терапевта', status: 'published' });
            expect(second.body.data.slug).toBe('priyom-terapevta-2');

            expectError(await create({ label: 'x', slug: 'priyom-terapevta' }), 409, 'SERVICE_SLUG_TAKEN');
            expectError(await create({ label: 'x', slug: 'Not a slug!' }), 400, 'VALIDATION_ERROR');

            const other = await fx.organization();
            const foreign = await t.http
                .post(`${t.prefix}/services`)
                .set('Authorization', superBearer)
                .send({ organization_id: other.id, label: 'x', slug: 'priyom-terapevta' });
            expect(foreign.status).toBe(201);

            const bySlug = await t.http.get(
                `${t.prefix}/organizations/${organization.id}/services/priyom-terapevta-2`,
            );
            expect(bySlug.status).toBe(200);
            expect(bySlug.body.data.id).toBe(second.body.data.id);
            expectError(
                await t.http.get(`${t.prefix}/organizations/${organization.id}/services/nope`),
                404,
                'SERVICE_NOT_FOUND',
            );

            const renamed = await t.http
                .patch(`${t.prefix}/services/${first.body.data.id}`)
                .set('Authorization', bearer)
                .send({ slug: 'therapist' });
            expect(renamed.body.data.slug).toBe('therapist');
            expectError(
                await t.http
                    .patch(`${t.prefix}/services/${first.body.data.id}`)
                    .set('Authorization', bearer)
                    .send({ slug: 'priyom-terapevta-2' }),
                409,
                'SERVICE_SLUG_TAKEN',
            );
        });

        it('a draft is invisible to the public and becomes visible once published', async () => {
            const draft = await create({ label: 'Draft' });
            expect(draft.body.data).toMatchObject({ status: 'draft', enabled: false, published_at: null });
            const id = draft.body.data.id as string;

            expectError(await t.http.get(`${t.prefix}/services/${id}`), 404, 'SERVICE_NOT_FOUND');
            expect((await t.http.get(`${t.prefix}/services`)).body.data).toHaveLength(0);
            const asAdmin = await t.http
                .get(`${t.prefix}/services?status=draft`)
                .set('Authorization', bearer);
            expect(asAdmin.body.data.map((item: { id: string }) => item.id)).toEqual([id]);

            const published = await t.http
                .put(`${t.prefix}/services/${id}/status`)
                .set('Authorization', bearer)
                .send({ status: 'published' });
            expect(published.status).toBe(200);
            expect(published.body.data).toMatchObject({ status: 'published', enabled: true });
            expect(typeof published.body.data.published_at).toBe('string');
            expect((await t.http.get(`${t.prefix}/services/${id}`)).status).toBe(200);

            const publishedAt = published.body.data.published_at as string;
            const disabled = await t.http
                .patch(`${t.prefix}/services/${id}`)
                .set('Authorization', bearer)
                .send({ enabled: false });
            expect(disabled.body.data).toMatchObject({
                status: 'draft',
                enabled: false,
                published_at: publishedAt,
            });
            const archived = await t.http
                .put(`${t.prefix}/services/${id}/status`)
                .set('Authorization', bearer)
                .send({ status: 'archived' });
            expect(archived.body.data.enabled).toBe(false);
            expectError(await t.http.get(`${t.prefix}/services/${id}`), 404);
        });
    });

    describe('descriptive fields', () => {
        it('stores and returns the catalogue fields, with a default currency and validated forms', async () => {
            const res = await create({
                label: 'Passport renewal',
                status: 'published',
                description: 'Bring the old passport.',
                tags: ['documents', 'passport', 'documents'],
                duration_minutes: 30,
                buffer_minutes: 10,
                price: 12.5,
                address: '1 Main Street',
                location: { lng: 27.56, lat: 53.9 },
                working_hours: [
                    { day: 'monday', from: '09:00', to: '13:00' },
                    { day: 'monday', from: '14:00', to: '18:00' },
                ],
                holidays: ['01-01', '03-08'],
                blackout_dates: ['2030-05-01'],
                booking_policy: {
                    max_active_per_user: 2,
                    lead_time_minutes: 60,
                    requires_confirmation: true,
                },
                form_fields: [
                    {
                        key: 'reason',
                        label: 'Reason',
                        type: 'select',
                        required: true,
                        options: ['lost', 'expired'],
                    },
                    { key: 'note', label: 'Note', type: 'textarea', max_length: 200 },
                ],
                required_documents: [{ key: 'old_passport', label: 'Old passport' }],
            });
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({
                description: 'Bring the old passport.',
                tags: ['documents', 'passport'],
                duration_minutes: 30,
                buffer_minutes: 10,
                price: 12.5,
                currency: 'USD',
                address: '1 Main Street',
                location: { type: 'Point', coordinates: [27.56, 53.9] },
                holidays: ['01-01', '03-08'],
                blackout_dates: ['2030-05-01'],
                booking_policy: {
                    max_active_per_user: 2,
                    lead_time_minutes: 60,
                    max_advance_days: null,
                    cancel_deadline_minutes: null,
                    requires_confirmation: true,
                },
                required_documents: [{ key: 'old_passport', label: 'Old passport', required: true }],
            });
            expect(res.body.data.working_hours).toHaveLength(2);
            expect(res.body.data.form_fields[0]).toMatchObject({
                key: 'reason',
                type: 'select',
                required: true,
            });

            expectError(
                await create({ form_fields: [{ key: 'x', label: 'X', type: 'select' }] }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(
                await create({ working_hours: [{ day: 'monday', from: '12:00', to: '09:00' }] }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(await create({ holidays: ['13-01'] }), 400, 'VALIDATION_ERROR');

            const cleared = await t.http
                .patch(`${t.prefix}/services/${res.body.data.id}`)
                .set('Authorization', bearer)
                .send({ location: null, price: null, tags: [] });
            expect(cleared.body.data.location).toBeUndefined();
            expect(cleared.body.data.price).toBeNull();
            expect(cleared.body.data.tags).toEqual([]);
        });
    });

    describe('search, tags, fields and include', () => {
        it('finds by full text and by tag, trims rows to the requested fields and embeds parents', async () => {
            const category = await fx.category(organization.id, { label: 'Health' });
            const dentist = await fx.service(organization.id, {
                label: 'Dentist',
                tags: ['teeth', 'health'],
                category_id: category.id,
                value: { heading_value: 'Dental check-up' },
            });
            await fx.service(organization.id, { label: 'Library card', tags: ['culture'] });

            const byText = await t.http.get(`${t.prefix}/services?q=dental`);
            expect(byText.status).toBe(200);
            expect(byText.body.data.map((item: { id: string }) => item.id)).toEqual([dentist.id]);
            expect(byText.body.meta.total).toBe(1);

            const byTag = await t.http.get(`${t.prefix}/services?tags=health,nothing`);
            expect(byTag.body.data.map((item: { id: string }) => item.id)).toEqual([dentist.id]);

            const sparse = await t.http.get(`${t.prefix}/services?fields=label,slug`);
            expect(sparse.status).toBe(200);
            expect(Object.keys(sparse.body.data[0]).sort()).toEqual(['id', 'label', 'slug']);
            expectError(
                await t.http.get(`${t.prefix}/services?fields=label,password`),
                400,
                'FIELDS_NOT_ALLOWED',
            );
            expectError(await t.http.get(`${t.prefix}/services?fields=Label`), 400, 'VALIDATION_ERROR');

            const included = await t.http.get(
                `${t.prefix}/services/${dentist.id}?include=organization,category&fields=id,organization,category`,
            );
            expect(included.body.data.organization).toMatchObject({ id: organization.id, status: 'active' });
            expect(included.body.data.category).toMatchObject({ id: category.id, label: 'Health' });
            expect(included.body.data.label).toBeUndefined();
            expectError(await t.http.get(`${t.prefix}/services?include=bookings`), 400, 'VALIDATION_ERROR');
        });
    });

    describe('nearby', () => {
        it('lists services and organizations around a point, nearest first, with the distance', async () => {
            const near = await fx.service(organization.id, {
                label: 'Near',
                location: { type: 'Point', coordinates: [27.56, 53.9] },
            });
            const far = await fx.service(organization.id, {
                label: 'Far',
                location: { type: 'Point', coordinates: [27.6, 53.9] },
            });
            await fx.service(organization.id, { label: 'Nowhere' });
            await fx
                .collection('Organization')
                .updateOne(
                    { _id: new Types.ObjectId(organization.id) },
                    { $set: { location: { type: 'Point', coordinates: [27.561, 53.9] } } },
                );

            const res = await t.http.get(
                `${t.prefix}/services/nearby?lat=53.9&lng=27.55&radius_m=1500&fields=id,label,distance_m`,
            );
            expect(res.status).toBe(200);
            expect(res.body.data.map((item: { id: string }) => item.id)).toEqual([near.id]);
            expect(res.body.data[0].distance_m).toBeGreaterThan(600);
            expect(res.body.data[0].distance_m).toBeLessThan(700);

            const wide = await t.http.get(`${t.prefix}/services/nearby?lat=53.9&lng=27.55&radius_m=10000`);
            expect(wide.body.data.map((item: { id: string }) => item.id)).toEqual([near.id, far.id]);
            expectError(
                await t.http.get(`${t.prefix}/services/nearby?lat=91&lng=0`),
                400,
                'VALIDATION_ERROR',
            );

            const organizations = await t.http.get(`${t.prefix}/organizations/nearby?lat=53.9&lng=27.55`);
            expect(organizations.body.data.map((item: { id: string }) => item.id)).toEqual([organization.id]);
            expect(typeof organizations.body.data[0].distance_m).toBe('number');
        });
    });

    describe('trash and history', () => {
        it('soft-deletes, hides, restores and purges, and every write leaves a revision', async () => {
            const created = await create({ label: 'Original', status: 'published', tags: ['a'] });
            const id = created.body.data.id as string;
            await t.http
                .patch(`${t.prefix}/services/${id}`)
                .set('Authorization', bearer)
                .send({ label: 'Renamed' });

            expect(
                (await t.http.delete(`${t.prefix}/services/${id}`).set('Authorization', bearer)).status,
            ).toBe(204);
            expectError(await t.http.get(`${t.prefix}/services/${id}`), 404, 'SERVICE_NOT_FOUND');
            expectError(await t.http.get(`${t.prefix}/services/${id}`).set('Authorization', bearer), 404);
            expectError(
                await t.http
                    .patch(`${t.prefix}/services/${id}`)
                    .set('Authorization', bearer)
                    .send({ label: 'x' }),
                404,
                'SERVICE_NOT_FOUND',
            );
            expect(
                (await t.http.get(`${t.prefix}/services`).set('Authorization', bearer)).body.data,
            ).toHaveLength(0);
            const trash = await t.http.get(`${t.prefix}/services?deleted=true`).set('Authorization', bearer);
            expect(trash.body.data.map((item: { id: string }) => item.id)).toEqual([id]);
            expect(typeof trash.body.data[0].deleted_at).toBe('string');
            expect((await t.http.get(`${t.prefix}/services?deleted=true`)).body.data).toHaveLength(0);

            const restored = await t.http
                .post(`${t.prefix}/services/${id}/restore`)
                .set('Authorization', bearer);
            expect(restored.status).toBe(200);
            expect(restored.body.data.deleted_at).toBeNull();
            expectError(
                await t.http.post(`${t.prefix}/services/${id}/restore`).set('Authorization', bearer),
                422,
                'SERVICE_NOT_DELETED',
            );

            const history = await t.http
                .get(`${t.prefix}/services/${id}/history`)
                .set('Authorization', bearer);
            expect(history.status).toBe(200);
            expect(history.body.data.map((row: { action: string }) => row.action)).toEqual([
                'restore',
                'delete',
                'update',
                'create',
            ]);
            const update = history.body.data[2];
            expect(update).toMatchObject({ actor_id: admin.id, actor_role: 'common-admin' });
            expect(update.changes).toEqual({ label: { before: 'Original', after: 'Renamed' } });
            expect(history.body.data[3].changes.tags).toEqual({ before: undefined, after: ['a'] });

            expectError(
                await t.http.delete(`${t.prefix}/services/${id}?permanent=true`).set('Authorization', bearer),
                403,
            );

            await t.http.delete(`${t.prefix}/services/${id}`).set('Authorization', bearer);
            await fx
                .collection('Service')
                .updateOne({ _id: new Types.ObjectId(id) }, { $set: { deleted_at: new Date('2000-01-01') } });
            expect(await t.app.get(TrashPurgeJob).execute(new Date())).toEqual({ purged: 1 });
            expect(await fx.collection('Service').countDocuments({})).toBe(0);
            expect(await fx.collection('ServiceRevision').countDocuments({})).toBe(0);
        });
    });

    describe('recurrence from working hours', () => {
        it('cuts the working hours into appointments and skips holidays of the service and the organization', async () => {
            await fx
                .collection('Organization')
                .updateOne({ _id: new Types.ObjectId(organization.id) }, { $set: { holidays: ['09-14'] } });
            const optionId = '11111111-1111-4111-8111-111111111111';
            const service = await fx.service(organization.id, {
                working_hours: [{ day: 'monday', from: '09:00', to: '10:30' }],
                duration_minutes: 30,
                buffer_minutes: 15,
                blackout_dates: ['2026-09-21'],
                options: [
                    {
                        id: optionId,
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        recurrent_dates: [{ day: 'monday', time: [], limit: 3 }],
                        slots: [],
                    },
                ],
            });
            expect(await t.app.get(RecurrentSlotsJob).execute(new Date('2026-09-05T00:00:00Z'))).toEqual({
                services_updated: 1,
            });
            const slots = await fx.storedSlots(service.id);
            expect(slots.map((slot) => slot.value.date)).toEqual(['2026-09-07', '2026-09-28', '2026-10-05']);
            expect(slots[0]!.value.time).toEqual([
                { time: '09:00', limit: 3, booked_count: 0 },
                { time: '09:45', limit: 3, booked_count: 0 },
            ]);
        });
    });
});

describe('services visibility across organizations (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());

    it('an admin of another organization sees neither drafts nor the trash of this one', async () => {
        await t.clearDatabase();
        const organization = await fx.organization();
        const draft = await fx.service(organization.id, { status: 'draft', enabled: false });
        const trashed = await fx.service(organization.id, { deleted_at: new Date() });
        const own = await fx.bearer(await fx.admin([organization.id]));
        const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));

        const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((item) => item.id);
        expect(ids(await t.http.get(`${t.prefix}/services`).set('Authorization', own))).toEqual([draft.id]);
        expect(ids(await t.http.get(`${t.prefix}/services?deleted=true`).set('Authorization', own))).toEqual([
            trashed.id,
        ]);
        expect(ids(await t.http.get(`${t.prefix}/services`).set('Authorization', foreign))).toEqual([]);
        expect(
            ids(await t.http.get(`${t.prefix}/services?deleted=true`).set('Authorization', foreign)),
        ).toEqual([]);
        expect((await t.http.get(`${t.prefix}/services/${draft.id}`).set('Authorization', own)).status).toBe(
            200,
        );
        expectError(await t.http.get(`${t.prefix}/services/${draft.id}`).set('Authorization', foreign), 404);
    });
});
