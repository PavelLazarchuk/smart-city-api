import { Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('users administration (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let config: AppConfig;
    let superBearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        config = t.app.get(AppConfig);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        config.auth.adminLoginMethod = 'password';
        superBearer = await fx.bearer(await fx.superAdmin());
    });

    const create = (body: Record<string, unknown>) =>
        t.http.post(`${t.prefix}/users`).set('Authorization', superBearer).send(body);
    const update = (user: FixtureUser, body: Record<string, unknown>) =>
        t.http.patch(`${t.prefix}/users/${user.id}`).set('Authorization', superBearer).send(body);
    const stored = (id: string) =>
        fx
            .collection<Record<string, unknown>>('User')
            .findById(id)
            .select('+password_hash')
            .lean<Record<string, unknown>>();

    describe('create', () => {
        it('creates a client by phone and refuses one without', async () => {
            const created = await create({ role: 'common-user', phone: '4915290101010', name: 'Ivy' });
            expect(created.status).toBe(201);
            expect(created.body.data).toMatchObject({ role: 'common-user', phone: '4915290101010' });
            expect((await stored(created.body.data.id as string))!['password_hash']).toBeUndefined();

            expectError(
                await create({ role: 'common-user', name: 'No phone' }),
                422,
                'CLIENT_PHONE_REQUIRED',
            );
        });

        it('asks staff for a phone instead of a password while staff sign in by SMS', async () => {
            config.auth.adminLoginMethod = 'sms';

            expectError(
                await create({ role: 'common-admin', login: 'desk_admin', password: 'Password-123!' }),
                422,
                'ADMIN_PHONE_REQUIRED',
            );
            const created = await create({ role: 'operator', phone: '4915290202020' });
            expect(created.status).toBe(201);
            expect(created.body.data.login).toBeUndefined();
        });

        it('refuses a short login, a foreign phone, a taken phone and unknown organizations', async () => {
            const taken = await fx.client();

            expectError(
                await create({ role: 'common-admin', login: 'ab', password: 'Password-123!' }),
                422,
                'LOGIN_TOO_SHORT',
            );
            expectError(
                await create({ role: 'common-user', phone: '375291234567' }),
                422,
                'PHONE_COUNTRY_NOT_SUPPORTED',
            );
            expectError(await create({ role: 'common-user', phone: taken.phone }), 409);
            expectError(
                await create({
                    role: 'common-admin',
                    login: 'new_admin',
                    password: 'Password-123!',
                    organization_ids: [new Types.ObjectId().toHexString()],
                }),
                404,
            );
        });
    });

    describe('list', () => {
        it('filters by role and organization', async () => {
            const organization = await fx.organization();
            const member = await fx.admin([organization.id]);
            await fx.admin([]);
            await fx.client();

            const members = await t.http
                .get(`${t.prefix}/users?organization_id=${organization.id}`)
                .set('Authorization', superBearer);
            expect(members.body.data.map((row: { id: string }) => row.id)).toEqual([member.id]);

            const clients = await t.http
                .get(`${t.prefix}/users?role=common-user`)
                .set('Authorization', superBearer);
            expect(clients.body.meta.total).toBe(1);
        });
    });

    describe('update by a super-admin', () => {
        it('sets and clears name, e-mail and phone of a staff member', async () => {
            const admin = await fx.admin([]);

            const filled = await update(admin, {
                name: 'Desk',
                email: 'desk@example.com',
                phone: '4915290303030',
            });
            expect(filled.status).toBe(200);
            expect(filled.body.data).toMatchObject({ name: 'Desk', phone: '4915290303030' });
            expect(await stored(admin.id)).toMatchObject({ email: 'desk@example.com' });

            const cleared = await update(admin, { name: null, email: null, phone: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.data.phone).toBeUndefined();
            const row = await stored(admin.id);
            expect(row!['email']).toBeUndefined();
            expect(row!['name']).toBeUndefined();
        });

        it('refuses to leave an account without the identifier it signs in with', async () => {
            const admin = await fx.admin([]);
            const client = await fx.client();

            expectError(await update(admin, { login: null }), 422, 'ADMIN_PASSWORD_REQUIRED');
            expectError(await update(client, { phone: null }), 422, 'CLIENT_PHONE_REQUIRED');
            expectError(await update(admin, { login: 'xy' }), 422, 'LOGIN_TOO_SHORT');
            expectError(await update(admin, { phone: '375291234567' }), 422, 'PHONE_COUNTRY_NOT_SUPPORTED');
        });

        it('lets a staff member drop the login once staff sign in by SMS', async () => {
            config.auth.adminLoginMethod = 'sms';
            const admin = await fx.user({ role: 'common-admin', login: 'old_login', phone: '4915290404040' });

            const res = await update(admin, { login: null });
            expect(res.status).toBe(200);
            expect(res.body.data.login).toBeUndefined();
        });

        it('promotes a client to staff only with a login and a password', async () => {
            const client = await fx.client();

            expectError(await update(client, { role: 'operator' }), 422, 'ADMIN_PASSWORD_REQUIRED');
            const promoted = await update(client, {
                role: 'operator',
                login: 'promoted_op',
                password: 'Password-123!',
            });
            expect(promoted.status).toBe(200);
            expect(promoted.body.data).toMatchObject({ role: 'operator', login: 'promoted_op' });

            const signIn = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ login: 'promoted_op', password: 'Password-123!' });
            expect(signIn.status).toBe(200);
        });

        it('refuses a login or phone another account holds', async () => {
            const first = await fx.admin([]);
            const second = await fx.admin([]);
            const client = await fx.client();

            expectError(await update(second, { login: first.login }), 409);
            expectError(await update(second, { phone: client.phone }), 409);
        });

        it('keeps the sessions of the account when only its name changes', async () => {
            const admin = await fx.admin([]);
            const bearer = await fx.bearer(admin);

            expect((await update(admin, { name: 'Renamed' })).status).toBe(200);
            expect((await t.http.get(`${t.prefix}/auth/me`).set('Authorization', bearer)).status).toBe(200);

            expect((await update(admin, { login: 'renamed_login' })).status).toBe(200);
            expectError(await t.http.get(`${t.prefix}/auth/me`).set('Authorization', bearer), 401);
        });

        it('answers 404 for an unknown account', async () => {
            const ghost = { id: new Types.ObjectId().toHexString() } as FixtureUser;

            expectError(await update(ghost, { name: 'x' }), 404, 'USER_NOT_FOUND');
            expectError(
                await t.http
                    .put(`${t.prefix}/users/${ghost.id}/organizations`)
                    .set('Authorization', superBearer)
                    .send({ organization_ids: [] }),
                404,
                'USER_NOT_FOUND',
            );
        });

        it('deduplicates organization ids on membership replace', async () => {
            const organization = await fx.organization();
            const admin = await fx.admin([]);

            const res = await t.http
                .put(`${t.prefix}/users/${admin.id}/organizations`)
                .set('Authorization', superBearer)
                .send({ organization_ids: [organization.id, organization.id] });
            expect(res.status).toBe(200);
            expect(res.body.data.organization_ids).toEqual([organization.id]);
        });
    });

    describe('bookings of an account', () => {
        it('lists only active bookings, each with its slot date and time', async () => {
            const organization = await fx.organization();
            const client = await fx.client();
            const option = fx.bookableOption(5);
            const service = await fx.service(organization.id, { options: [option] });
            const dated = await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
                slot_date: '2030-01-02',
            });
            const pending = await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: 'apply-slot',
                user_id: client.id,
                status: 'pending',
            });
            const cancelled = await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: 'apply-slot',
                user_id: client.id,
                status: 'cancelled',
            });

            const res = await t.http
                .get(`${t.prefix}/users/${client.id}/bookings`)
                .set('Authorization', await fx.bearer(client));
            expect(res.status).toBe(200);
            const byId = new Map(res.body.data.map((row: { id: string }) => [row.id, row]));
            expect(byId.get(dated.id)).toMatchObject({
                date: '2030-01-02',
                time: '10:00',
                status: 'confirmed',
            });
            expect(byId.get(pending.id)).toMatchObject({ status: 'pending', child_type: 'apply' });
            expect((byId.get(pending.id) as { date?: string }).date).toBeUndefined();
            expect(byId.has(cancelled.id)).toBe(false);
        });
    });
});
