import { expectError, expectNoSensitiveKeys } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('users (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('GET /users', () => {
        it('is super-admin only and paginated with the default limit', async () => {
            const superAdmin = await fx.superAdmin();
            const admin = await fx.admin([]);
            const client = await fx.client();

            for (let i = 0; i < 35; i += 1) await fx.client();

            expectError(await t.http.get(`${t.prefix}/users`), 401, 'UNAUTHENTICATED');
            expectError(
                await t.http.get(`${t.prefix}/users`).set('Authorization', await fx.bearer(admin)),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http.get(`${t.prefix}/users`).set('Authorization', await fx.bearer(client)),
                403,
                'FORBIDDEN',
            );

            const res = await t.http
                .get(`${t.prefix}/users`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(30);
            expect(res.body.meta).toEqual({
                page: 1,
                limit: 30,
                total: 38,
                total_pages: 2,
                has_next: true,
                dropped: 0,
            });
            expectNoSensitiveKeys(res.body);

            const filtered = await t.http
                .get(`${t.prefix}/users?role=super-admin`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(filtered.body.meta.total).toBe(1);
        });
    });

    describe('POST /users', () => {
        it('creates admins with login + password or a phone, and validates identifiers', async () => {
            const superAdmin = await fx.superAdmin();
            const bearer = await fx.bearer(superAdmin);
            const organization = await fx.organization();

            const created = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({
                    login: 'newadmin',
                    password: 'Strong-Passw0rd',
                    role: 'common-admin',
                    organization_ids: [organization.id],
                });
            expect(created.status).toBe(201);
            expect(created.headers['location']).toBe(`/users/${created.body.data.id}`);
            expect(created.body.data.organization_ids).toEqual([organization.id]);
            expectNoSensitiveKeys(created.body);

            const dup = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({ login: 'newadmin', password: 'Strong-Passw0rd', role: 'common-admin' });
            expectError(dup, 409, 'LOGIN_TAKEN');

            const noIdentifier = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({ role: 'common-admin', name: 'X' });
            expectError(noIdentifier, 422, 'ADMIN_PASSWORD_REQUIRED');

            const smsAdmin = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({ phone: '375291234567', role: 'common-admin' });
            expectError(smsAdmin, 422, 'ADMIN_PASSWORD_REQUIRED');

            const loginWithoutPassword = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({ login: 'nopassword', role: 'common-admin' });
            expectError(loginWithoutPassword, 422, 'ADMIN_PASSWORD_REQUIRED');

            const clientNoPhone = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({ role: 'common-user', name: 'C' });
            expectError(clientNoPhone, 422, 'CLIENT_PHONE_REQUIRED');

            const unknownOrganization = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', bearer)
                .send({
                    login: 'another',
                    password: 'Strong-Passw0rd',
                    role: 'common-admin',
                    organization_ids: ['64b000000000000000000000'],
                });
            expectError(unknownOrganization, 404, 'ORGANIZATION_NOT_FOUND');
        });

        it('is forbidden for admins and clients', async () => {
            const admin = await fx.admin([]);
            const res = await t.http
                .post(`${t.prefix}/users`)
                .set('Authorization', await fx.bearer(admin))
                .send({ login: 'newadmin', password: 'Strong-Passw0rd', role: 'common-admin' });
            expectError(res, 403, 'FORBIDDEN');
        });
    });

    describe('GET / PATCH / DELETE /users/:id', () => {
        it('allows self or super-admin, never another user', async () => {
            const superAdmin = await fx.superAdmin();
            const a = await fx.client();
            const b = await fx.client();
            const bearerA = await fx.bearer(a);

            const self = await t.http.get(`${t.prefix}/users/${a.id}`).set('Authorization', bearerA);
            expect(self.status).toBe(200);
            expect(self.body.data.phone).toBe(a.phone);
            expectNoSensitiveKeys(self.body);

            expectError(
                await t.http.get(`${t.prefix}/users/${b.id}`).set('Authorization', bearerA),
                403,
                'FORBIDDEN',
            );
            const bySuper = await t.http
                .get(`${t.prefix}/users/${b.id}`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(bySuper.status).toBe(200);
            expectError(
                await t.http
                    .get(`${t.prefix}/users/64b000000000000000000000`)
                    .set('Authorization', await fx.bearer(superAdmin)),
                404,
                'USER_NOT_FOUND',
            );
            expectError(
                await t.http
                    .get(`${t.prefix}/users/not-an-id`)
                    .set('Authorization', await fx.bearer(superAdmin)),
                404,
                'USER_NOT_FOUND',
            );
        });

        it('uses the self schema for the account itself and the admin schema for super-admins', async () => {
            const superAdmin = await fx.superAdmin();
            const client = await fx.client();
            const bearer = await fx.bearer(client);

            const renamed = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', bearer)
                .send({ name: 'Renamed' });
            expect(renamed.status).toBe(200);
            expect(renamed.body.data.name).toBe('Renamed');

            const escalate = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', bearer)
                .send({ name: 'X', role: 'super-admin' });
            expect(escalate.status).toBe(200);
            expect(escalate.body.data.role).toBe('common-user');

            const byAdmin = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', await fx.bearer(superAdmin))
                .send({ role: 'common-admin', login: 'promoted', password: 'Strong-Passw0rd', phone: null });
            expect(byAdmin.status).toBe(200);
            expect(byAdmin.body.data.role).toBe('common-admin');
            expect(byAdmin.body.data.login).toBe('promoted');
            expect(byAdmin.body.data.phone).toBeUndefined();
        });

        it('lets the account set, normalise, share and clear its contact e-mail', async () => {
            const client = await fx.client();
            const other = await fx.client();
            const bearer = await fx.bearer(client);

            const set = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', bearer)
                .send({ email: '  Anna@Example.COM ' });
            expect(set.status).toBe(200);
            expect(set.body.data.email).toBe('anna@example.com');

            const shared = await t.http
                .patch(`${t.prefix}/users/${other.id}`)
                .set('Authorization', await fx.bearer(other))
                .send({ email: 'anna@example.com' });
            expect(shared.status).toBe(200);
            expect(shared.body.data.email).toBe('anna@example.com');

            expectError(
                await t.http
                    .patch(`${t.prefix}/users/${client.id}`)
                    .set('Authorization', bearer)
                    .send({ email: 'not-an-address' }),
                400,
                'VALIDATION_ERROR',
            );

            const cleared = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', bearer)
                .send({ email: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.data.email).toBeUndefined();
        });

        it('rejects an invalid PATCH body with 400, never 500', async () => {
            const superAdmin = await fx.superAdmin();
            const client = await fx.client();

            const bad = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', await fx.bearer(superAdmin))
                .send({ role: 'emperor' });
            expectError(bad, 400, 'VALIDATION_ERROR');
            expect(bad.body.error.details[0].path).toBe('role');

            const empty = await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', await fx.bearer(client))
                .send({});
            expect(empty.status).toBe(200);
            expectError(
                await t.http
                    .patch(`${t.prefix}/users/${client.id}`)
                    .set('Authorization', await fx.bearer(client))
                    .send({ name: '' }),
                400,
                'VALIDATION_ERROR',
            );
        });

        it('keeps at least one super-admin and refuses a self role change', async () => {
            const only = await fx.superAdmin();
            const bearer = await fx.bearer(only);

            expectError(
                await t.http
                    .patch(`${t.prefix}/users/${only.id}`)
                    .set('Authorization', bearer)
                    .send({ role: 'common-user' }),
                422,
                'SELF_ROLE_CHANGE',
            );
            expectError(
                await t.http.delete(`${t.prefix}/users/${only.id}`).set('Authorization', bearer),
                409,
                'LAST_SUPER_ADMIN',
            );

            const second = await fx.superAdmin();
            const demoted = await t.http
                .patch(`${t.prefix}/users/${second.id}`)
                .set('Authorization', bearer)
                .send({ role: 'common-admin' });
            expect(demoted.status).toBe(200);
            expect(demoted.body.data.role).toBe('common-admin');
            expect(
                (await t.http.delete(`${t.prefix}/users/${only.id}`).set('Authorization', bearer)).status,
            ).toBe(409);
        });

        it('a role or password change by a super-admin revokes the account’s sessions', async () => {
            const superAdmin = await fx.superAdmin();
            const target = await fx.client();
            const targetToken = await fx.token(target);
            expect(
                (await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${targetToken.access}`))
                    .status,
            ).toBe(200);

            const changed = await t.http
                .patch(`${t.prefix}/users/${target.id}`)
                .set('Authorization', await fx.bearer(superAdmin))
                .send({ name: 'Renamed', password: 'Brand-New-Pass1' });
            expect(changed.status).toBe(200);
            expectError(
                await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${targetToken.access}`),
                401,
            );
        });

        it('PUT /users/:id/organizations replaces membership after checking the ids exist', async () => {
            const superAdmin = await fx.superAdmin();
            const admin = await fx.admin([]);
            const organization = await fx.organization();
            const bearer = await fx.bearer(superAdmin);

            const missing = await t.http
                .put(`${t.prefix}/users/${admin.id}/organizations`)
                .set('Authorization', bearer)
                .send({ organization_ids: [organization.id, '64b000000000000000000000'] });
            expectError(missing, 404, 'ORGANIZATION_NOT_FOUND');

            const ok = await t.http
                .put(`${t.prefix}/users/${admin.id}/organizations`)
                .set('Authorization', bearer)
                .send({ organization_ids: [organization.id, organization.id] });
            expect(ok.status).toBe(200);
            expect(ok.body.data.organization_ids).toEqual([organization.id]);

            expectError(
                await t.http
                    .put(`${t.prefix}/users/${admin.id}/organizations`)
                    .set('Authorization', await fx.bearer(admin))
                    .send({ organization_ids: [] }),
                403,
                'FORBIDDEN',
            );
        });

        it('DELETE removes the user with sessions and codes, in one transaction', async () => {
            const superAdmin = await fx.superAdmin();
            const client = await fx.client();
            const bearer = await fx.bearer(client);
            const res = await t.http
                .delete(`${t.prefix}/users/${client.id}`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(res.status).toBe(204);
            expect(await fx.collection('User').countDocuments({ _id: client.id })).toBe(0);
            expectError(await t.http.get(`${t.prefix}/auth/me`).set('Authorization', bearer), 401);
        });

        it('GET /users/:id/bookings is self or super-admin', async () => {
            const client = await fx.client();
            const other = await fx.client();
            const res = await t.http
                .get(`${t.prefix}/users/${client.id}/bookings`)
                .set('Authorization', await fx.bearer(client));
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
            expectError(
                await t.http
                    .get(`${t.prefix}/users/${client.id}/bookings`)
                    .set('Authorization', await fx.bearer(other)),
                403,
            );
        });
    });
});
