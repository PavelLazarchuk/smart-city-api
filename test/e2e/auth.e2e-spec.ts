import { type Model, Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { type Session } from '../../src/modules/auth/schemas/session.schema';
import { type VerificationCode } from '../../src/modules/auth/schemas/verification-code.schema';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError, expectNoSensitiveKeys } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('auth (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let sentCodes: string[];

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        sentCodes = [];
        const sms = t.app.get(ConsoleSmsProvider);
        jest.spyOn(sms, 'send').mockImplementation((_phone: string, text: string) => {
            sentCodes.push(text.split(' ')[0] ?? '');

            return Promise.resolve();
        });
    });

    afterAll(async () => {
        await t.close();
    });

    beforeEach(async () => {
        await t.clearDatabase();
        sentCodes = [];
        const config = t.app.get(AppConfig);
        config.auth.adminLoginMethod = 'password';
        config.auth.citizenLoginMethod = 'sms';
    });

    describe('health', () => {
        it('GET /health/live and /health/ready are public', async () => {
            const live = await t.http.get(`${t.prefix}/health/live`);
            expect(live.status).toBe(200);
            const ready = await t.http.get(`${t.prefix}/health/ready`);
            expect(ready.status).toBe(200);
            expect(ready.body.info.mongodb.status).toBe('up');
        });

        it('serves the OpenAPI document', async () => {
            const res = await t.http.get('/api/docs-json');
            expect(res.status).toBe(200);
            expect(res.body.paths[`${t.prefix}/auth/login`]).toBeDefined();
        });
    });

    describe('POST /auth/login', () => {
        it('returns a token pair for an admin with login + password', async () => {
            const admin = await fx.superAdmin();
            const res = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ login: admin.login, password: admin.password });
            expect(res.status).toBe(200);
            expect(res.body.data.token_type).toBe('Bearer');
            expect(typeof res.body.data.access_token).toBe('string');
            expect(typeof res.body.data.refresh_token).toBe('string');
            expect(res.body.data.expires_in).toBe(15 * 60);
            expect(res.body.data.user.role).toBe('super-admin');
            expectNoSensitiveKeys(res.body);
        });

        it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
            const admin = await fx.superAdmin();
            const res = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ login: admin.login, password: 'nope-nope-nope' });
            expectError(res, 401, 'INVALID_CREDENTIALS');
        });

        it('rejects an unknown login with the same error', async () => {
            const res = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ login: 'ghost', password: 'nope-nope-nope' });
            expectError(res, 401, 'INVALID_CREDENTIALS');
        });

        it('validates the body (400 with details)', async () => {
            const res = await t.http.post(`${t.prefix}/auth/login`).send({ password: 'x' });
            expectError(res, 400, 'VALIDATION_ERROR');
            expect(Array.isArray(res.body.error.details)).toBe(true);
        });

        it('refuses password login for citizens while the citizen method is sms', async () => {
            const citizen = await fx.citizen({ password: 'Citizen-Pass1' });
            const res = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ phone: citizen.phone, password: 'Citizen-Pass1' });
            expectError(res, 401, 'INVALID_CREDENTIALS');
        });

        it('does not reveal whether an account exists when its method is disabled', async () => {
            const citizen = await fx.citizen({ password: 'Citizen-Pass1' });
            const known = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ phone: citizen.phone, password: 'wrong-password' });
            const unknown = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ phone: '375299999999', password: 'wrong-password' });
            expect(known.status).toBe(unknown.status);
            expect(known.body.error.code).toBe(unknown.body.error.code);
        });

        it('allows password login for citizens when the citizen method is password', async () => {
            t.app.get(AppConfig).auth.citizenLoginMethod = 'password';
            const citizen = await fx.citizen({ password: 'Citizen-Pass1' });
            const res = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ phone: citizen.phone, password: 'Citizen-Pass1' });
            expect(res.status).toBe(200);
            expect(res.body.data.user.role).toBe('common-user');
        });
    });

    describe('POST /auth/register', () => {
        it('is disabled while the citizen method is sms', async () => {
            const res = await t.http
                .post(`${t.prefix}/auth/register`)
                .send({ phone: '375291112233', password: 'Citizen-Pass1', name: 'New' });
            expectError(res, 403, 'LOGIN_METHOD_DISABLED');
        });

        it('creates the citizen and returns 201 + pair under the password method', async () => {
            t.app.get(AppConfig).auth.citizenLoginMethod = 'password';
            const res = await t.http
                .post(`${t.prefix}/auth/register`)
                .send({ phone: '375291112233', password: 'Citizen-Pass1', name: 'New' });
            expect(res.status).toBe(201);
            expect(res.body.data.user.phone).toBe('375291112233');
            const dup = await t.http
                .post(`${t.prefix}/auth/register`)
                .send({ phone: '375291112233', password: 'Citizen-Pass1', name: 'New' });
            expectError(dup, 409, 'PHONE_TAKEN');
        });

        it('enforces the password policy from config', async () => {
            t.app.get(AppConfig).auth.citizenLoginMethod = 'password';
            const res = await t.http
                .post(`${t.prefix}/auth/register`)
                .send({ phone: '375291112233', password: 'short', name: 'New' });
            expectError(res, 422, 'PASSWORD_TOO_SHORT');
        });
    });

    describe('OTP flow', () => {
        it('request stores a hashed code, creates no user, and answers identically for unknown phones', async () => {
            const res = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '375291000001' });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ phone: '375291000001', expires_in: 300 });
            expect(sentCodes).toHaveLength(1);
            const codes = t.app.get<Model<VerificationCode>>('VerificationCodeModel');
            const stored = await codes.findOne({ phone: '375291000001' }).select('+code_hash').lean();
            expect(stored?.code_hash).toBeDefined();
            expect(stored?.code_hash).not.toBe(sentCodes[0]);
            const users = await fx.collection('User').countDocuments({ phone: '375291000001' });
            expect(users).toBe(0);
        });

        it('verify creates the citizen on first success and returns a pair', async () => {
            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '375291000002' });
            const res = await t.http
                .post(`${t.prefix}/auth/otp/verify`)
                .send({ phone: '375291000002', code: sentCodes[0], name: 'Anna' });
            expect(res.status).toBe(200);
            expect(res.body.data.user.role).toBe('common-user');
            expect(res.body.data.user.name).toBe('Anna');
            expectNoSensitiveKeys(res.body);
            const again = await t.http
                .post(`${t.prefix}/auth/otp/verify`)
                .send({ phone: '375291000002', code: sentCodes[0] });
            expectError(again, 401, 'OTP_INVALID');
        });

        it('counts attempts and locks after the configured maximum', async () => {
            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '375291000003' });

            for (let i = 0; i < 3; i += 1) {
                const bad = await t.http
                    .post(`${t.prefix}/auth/otp/verify`)
                    .send({ phone: '375291000003', code: '000000' });
                expectError(bad, 401, 'OTP_INVALID');
            }

            const locked = await t.http
                .post(`${t.prefix}/auth/otp/verify`)
                .send({ phone: '375291000003', code: sentCodes[0] });
            expectError(locked, 401, 'OTP_ATTEMPTS_EXCEEDED');
        });

        it('a new code does not reset the guessing budget of the number', async () => {
            const phone = '375291000005';
            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone });

            for (let i = 0; i < 2; i += 1) {
                expectError(
                    await t.http.post(`${t.prefix}/auth/otp/verify`).send({ phone, code: '000000' }),
                    401,
                    'OTP_INVALID',
                );
            }

            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone });
            expectError(
                await t.http.post(`${t.prefix}/auth/otp/verify`).send({ phone, code: '000000' }),
                401,
                'OTP_INVALID',
            );
            expectError(
                await t.http.post(`${t.prefix}/auth/otp/verify`).send({ phone, code: sentCodes.at(-1) }),
                401,
                'OTP_ATTEMPTS_EXCEEDED',
            );
        });

        it('rejects phones outside the configured country', async () => {
            const res = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '491511234567' });
            expectError(res, 422, 'PHONE_COUNTRY_NOT_SUPPORTED');
        });

        it('is disabled entirely when neither audience uses sms', async () => {
            t.app.get(AppConfig).auth.citizenLoginMethod = 'password';
            const res = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '375291000004' });
            expectError(res, 403, 'LOGIN_METHOD_DISABLED');
        });
    });

    describe('refresh / logout', () => {
        it('rotates the pair, re-reads the role, and detects reuse', async () => {
            const citizen = await fx.citizen();
            const first = await fx.token(citizen);

            const rotated = await t.http
                .post(`${t.prefix}/auth/refresh`)
                .send({ refresh_token: first.refresh });
            expect(rotated.status).toBe(200);
            expect(rotated.body.data.refresh_token).not.toBe(first.refresh);

            const reuse = await t.http
                .post(`${t.prefix}/auth/refresh`)
                .send({ refresh_token: first.refresh });
            expectError(reuse, 401, 'REFRESH_TOKEN_REUSED');

            const afterReuse = await t.http
                .post(`${t.prefix}/auth/refresh`)
                .send({ refresh_token: rotated.body.data.refresh_token });
            expectError(afterReuse, 401);
            const sessions = t.app.get<Model<Session>>('SessionModel');
            const revoked = await sessions.countDocuments({
                user_id: new Types.ObjectId(citizen.id),
                revoked_at: { $exists: true },
            });
            expect(revoked).toBe(2);
        });

        it('rejects a garbage or access token on refresh', async () => {
            const citizen = await fx.citizen();
            const { access } = await fx.token(citizen);
            expectError(
                await t.http.post(`${t.prefix}/auth/refresh`).send({ refresh_token: 'garbage' }),
                401,
                'TOKEN_INVALID',
            );
            expectError(
                await t.http.post(`${t.prefix}/auth/refresh`).send({ refresh_token: access }),
                401,
                'TOKEN_INVALID',
            );
        });

        it('logout revokes the session so the access token stops working', async () => {
            const citizen = await fx.citizen();
            const bearer = await fx.bearer(citizen);
            expect((await t.http.get(`${t.prefix}/auth/me`).set('Authorization', bearer)).status).toBe(200);
            expect((await t.http.post(`${t.prefix}/auth/logout`).set('Authorization', bearer)).status).toBe(
                204,
            );
            expectError(
                await t.http.get(`${t.prefix}/auth/me`).set('Authorization', bearer),
                401,
                'SESSION_REVOKED',
            );
        });

        it('logout-all revokes every session of the user', async () => {
            const citizen = await fx.citizen();
            const a = await fx.bearer(citizen);
            const b = await fx.bearer(citizen);
            expect((await t.http.post(`${t.prefix}/auth/logout-all`).set('Authorization', a)).status).toBe(
                204,
            );
            expectError(await t.http.get(`${t.prefix}/auth/me`).set('Authorization', b), 401);
        });
    });

    describe('GET /auth/me and PATCH /auth/password', () => {
        it('requires a token and returns the profile without secrets', async () => {
            expectError(await t.http.get(`${t.prefix}/auth/me`), 401, 'UNAUTHENTICATED');
            const admin = await fx.superAdmin();
            const res = await t.http.get(`${t.prefix}/auth/me`).set('Authorization', await fx.bearer(admin));
            expect(res.status).toBe(200);
            expect(res.body.data.id).toBe(admin.id);
            expectNoSensitiveKeys(res.body);
            expect(res.headers['x-request-id']).toBeDefined();
        });

        it('changes the password after verifying the current one', async () => {
            const admin = await fx.superAdmin();
            const bearer = await fx.bearer(admin);
            const wrong = await t.http.patch(`${t.prefix}/auth/password`).set('Authorization', bearer).send({
                current_password: 'wrong-password',
                new_password: 'New-Passw0rd1',
                new_password_confirmation: 'New-Passw0rd1',
            });
            expectError(wrong, 401, 'INVALID_CREDENTIALS');
            const ok = await t.http.patch(`${t.prefix}/auth/password`).set('Authorization', bearer).send({
                current_password: admin.password,
                new_password: 'New-Passw0rd1',
                new_password_confirmation: 'New-Passw0rd1',
            });
            expect(ok.status).toBe(204);
            const login = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ login: admin.login, password: 'New-Passw0rd1' });
            expect(login.status).toBe(200);
        });

        it('rejects a password change whose confirmation does not match', async () => {
            const admin = await fx.superAdmin();
            const res = await t.http
                .patch(`${t.prefix}/auth/password`)
                .set('Authorization', await fx.bearer(admin))
                .send({
                    current_password: admin.password,
                    new_password: 'New-Passw0rd1',
                    new_password_confirmation: 'New-Passw0rd2',
                });
            expectError(res, 400, 'VALIDATION_ERROR');
        });

        it('changing the password revokes every other session but keeps the caller signed in', async () => {
            const admin = await fx.superAdmin();
            const stolen = await fx.token(admin);
            const mine = await fx.token(admin);

            expect(
                (await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${stolen.access}`))
                    .status,
            ).toBe(200);
            const changed = await t.http
                .patch(`${t.prefix}/auth/password`)
                .set('Authorization', `Bearer ${mine.access}`)
                .send({
                    current_password: admin.password,
                    new_password: 'New-Passw0rd2',
                    new_password_confirmation: 'New-Passw0rd2',
                });
            expect(changed.status).toBe(204);

            expectError(
                await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${stolen.access}`),
                401,
            );
            expectError(
                await t.http.post(`${t.prefix}/auth/refresh`).send({ refresh_token: stolen.refresh }),
                401,
            );
            expect(
                (await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${mine.access}`))
                    .status,
            ).toBe(200);
        });

        it('returns a malformed token as 401 TOKEN_INVALID, never 500', async () => {
            expectError(
                await t.http.get(`${t.prefix}/auth/me`).set('Authorization', 'Bearer not-a-jwt'),
                401,
                'TOKEN_INVALID',
            );
        });
    });
});
