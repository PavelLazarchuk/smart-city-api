import { Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { OtpService } from '../../src/modules/auth/otp.service';
import { expectError } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('auth flows (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let config: AppConfig;
    let sent: { phone: string; text: string }[];

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        config = t.app.get(AppConfig);
        jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockImplementation(
            (phone: string, text: string) => {
                sent.push({ phone, text });

                return Promise.resolve();
            },
        );
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        sent = [];
        config.auth.adminLoginMethod = 'password';
        config.auth.clientLoginMethod = 'sms';
    });

    const verify = (body: Record<string, unknown>) => t.http.post(`${t.prefix}/auth/otp/verify`).send(body);
    const issue = (phone: string) => t.app.get(OtpService).issue(phone);
    const refresh = (token: string) => t.http.post(`${t.prefix}/auth/refresh`).send({ refresh_token: token });
    const stored = (id: string) =>
        fx
            .collection<{ name: string; email?: string }>('User')
            .findById(id)
            .lean<{ name: string; email?: string }>();

    describe('one-time codes', () => {
        it('signs a known client in and updates only the name and e-mail that changed', async () => {
            const client = await fx.client({ name: 'Anna', email: 'anna@example.com' });

            const same = await verify({
                phone: client.phone,
                code: await issue(client.phone!),
                name: 'Anna',
            });
            expect(same.status).toBe(200);
            expect(same.body.data.user.id).toBe(client.id);

            const renamed = await verify({
                phone: client.phone,
                code: await issue(client.phone!),
                name: 'Anna Maria',
                email: 'maria@example.com',
            });
            expect(renamed.body.data.user.name).toBe('Anna Maria');
            expect(await stored(client.id)).toMatchObject({ name: 'Anna Maria', email: 'maria@example.com' });

            const bare = await verify({ phone: client.phone, code: await issue(client.phone!) });
            expect(bare.body.data.user.name).toBe('Anna Maria');
        });

        it('quietly ignores a code request for staff while staff sign in with a password', async () => {
            const admin = await fx.user({ role: 'common-admin', phone: '4915290007777' });

            const res = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: admin.phone });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ phone: admin.phone, expires_in: 300 });
            expect(sent).toEqual([]);
            expect(await fx.collection('VerificationCode').countDocuments({ phone: admin.phone })).toBe(0);

            expectError(
                await verify({ phone: admin.phone, code: await issue(admin.phone!) }),
                403,
                'LOGIN_METHOD_DISABLED',
            );
        });

        it('signs staff in by code when their method is sms', async () => {
            config.auth.adminLoginMethod = 'sms';
            config.auth.clientLoginMethod = 'password';
            const admin = await fx.user({ role: 'common-admin', phone: '4915290006666' });

            const requested = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: admin.phone });
            expect(requested.status).toBe(200);
            expect(sent).toHaveLength(1);
            const code = sent[0]!.text.split(' ')[0];

            const res = await verify({ phone: admin.phone, code });
            expect(res.status).toBe(200);
            expect(res.body.data.user).toMatchObject({ id: admin.id, role: 'common-admin' });
        });

        it('creates no client account by code while clients sign in with a password', async () => {
            config.auth.adminLoginMethod = 'sms';
            config.auth.clientLoginMethod = 'password';
            const phone = '4915290005555';

            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone });
            expect(sent).toEqual([]);
            expectError(await verify({ phone, code: await issue(phone) }), 403, 'LOGIN_METHOD_DISABLED');
            expect(await fx.collection('User').countDocuments({ phone })).toBe(0);
        });

        it('answers the same even when the SMS gateway fails', async () => {
            jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockRejectedValueOnce(
                new Error('gateway down'),
            );

            const res = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '4915290004444' });
            expect(res.status).toBe(200);
            expect(await fx.collection('VerificationCode').countDocuments({ phone: '4915290004444' })).toBe(
                1,
            );
        });
    });

    describe('password login', () => {
        it('refuses an account that has no password with the same error as a wrong one', async () => {
            config.auth.clientLoginMethod = 'password';
            const client = await fx.client();

            expectError(
                await t.http
                    .post(`${t.prefix}/auth/login`)
                    .send({ phone: client.phone, password: 'Password-123' }),
                401,
                'INVALID_CREDENTIALS',
            );
        });

        it('lets a client with a password in by phone', async () => {
            config.auth.clientLoginMethod = 'password';
            const client = await fx.client({ password: 'Password-123' });

            const res = await t.http
                .post(`${t.prefix}/auth/login`)
                .send({ phone: client.phone, password: 'Password-123' });
            expect(res.status).toBe(200);
            expect(res.body.data.user.id).toBe(client.id);
        });

        it('refuses a body with both login and phone', async () => {
            expectError(
                await t.http
                    .post(`${t.prefix}/auth/login`)
                    .send({ login: 'someone', phone: '4915290001111', password: 'Password-123' }),
                400,
                'VALIDATION_ERROR',
            );
        });
    });

    describe('refresh', () => {
        it('refuses a token whose session is gone or whose hash no longer matches', async () => {
            const client = await fx.client();
            const gone = await fx.token(client);
            const tampered = await fx.token(client);

            await fx.collection('Session').deleteOne({ _id: new Types.ObjectId(gone.sid) });
            expectError(await refresh(gone.refresh), 401, 'TOKEN_INVALID');

            await fx
                .collection('Session')
                .updateOne(
                    { _id: new Types.ObjectId(tampered.sid) },
                    { $set: { refresh_token_hash: 'other' } },
                );
            expectError(await refresh(tampered.refresh), 401, 'TOKEN_INVALID');
        });

        it('refuses a session that has expired', async () => {
            const client = await fx.client();
            const pair = await fx.token(client);

            await fx
                .collection('Session')
                .updateOne(
                    { _id: new Types.ObjectId(pair.sid) },
                    { $set: { expires_at: new Date(Date.now() - 1000) } },
                );
            expectError(await refresh(pair.refresh), 401, 'TOKEN_EXPIRED');
        });

        it('refuses a session whose account was deleted', async () => {
            const client = await fx.client();
            const pair = await fx.token(client);

            await fx.collection('User').deleteOne({ _id: new Types.ObjectId(client.id) });
            expectError(await refresh(pair.refresh), 401, 'SESSION_REVOKED');
        });

        it('treats a refresh after logout as reuse and revokes the family', async () => {
            const client = await fx.client();
            const pair = await fx.token(client);

            expect(
                (await t.http.post(`${t.prefix}/auth/logout`).set('Authorization', `Bearer ${pair.access}`))
                    .status,
            ).toBe(204);
            expectError(await refresh(pair.refresh), 401, 'REFRESH_TOKEN_REUSED');
        });

        it('keeps the device details on the rotated session', async () => {
            const client = await fx.client();
            const pair = await fx.token(client);

            const rotated = await t.http
                .post(`${t.prefix}/auth/refresh`)
                .set('User-Agent', 'CityApp/2.0')
                .send({ refresh_token: pair.refresh });
            expect(rotated.status).toBe(200);
            expect(rotated.body.data.user.id).toBe(client.id);

            const sessions = await t.http
                .get(`${t.prefix}/auth/sessions`)
                .set('Authorization', `Bearer ${rotated.body.data.access_token as string}`);
            const current = sessions.body.data.find((row: { current: boolean }) => row.current);
            expect(current.user_agent).toBe('CityApp/2.0');
        });
    });
});
