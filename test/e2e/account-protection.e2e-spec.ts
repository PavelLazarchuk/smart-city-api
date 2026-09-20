import { Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('account protection (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let config: AppConfig;
    let smsProvider: jest.SpyInstance;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        config = t.app.get(AppConfig);
        smsProvider = jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockResolvedValue(undefined);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        smsProvider.mockClear();
        config.auth.maxFailedAttempts = 3;
        config.auth.lockoutSeconds = 300;
        config.auth.lockoutMaxSeconds = 3600;
        config.auth.failedAttemptWindowSeconds = 3600;
        config.sms.budget.hourlyLimit = 200;
        config.sms.budget.dailyLimit = 1000;
    });

    const login = (admin: FixtureUser, password: string) =>
        t.http.post(`${t.prefix}/auth/login`).send({ login: admin.login, password });

    describe('brute force on one account', () => {
        it('locks the account after the configured failures and keeps answering the same error', async () => {
            const admin = await fx.superAdmin();

            for (let attempt = 0; attempt < config.auth.maxFailedAttempts; attempt += 1) {
                expectError(await login(admin, 'wrong-password'), 401, 'INVALID_CREDENTIALS');
            }

            const stored = await fx
                .collection<{ failed_login_attempts: number; locked_until: Date }>('User')
                .findById(admin.id)
                .lean();
            expect(stored!.failed_login_attempts).toBe(3);
            expect(stored!.locked_until.getTime()).toBeGreaterThan(Date.now());

            // The right password is refused too, and the refusal is indistinguishable from a wrong one.
            expectError(await login(admin, admin.password!), 401, 'INVALID_CREDENTIALS');
        });

        it('lengthens the lock after each expired one, up to the configured ceiling', async () => {
            config.auth.lockoutSeconds = 60;
            config.auth.lockoutMaxSeconds = 240;
            const admin = await fx.superAdmin();
            const expireLock = () =>
                fx
                    .collection('User')
                    .updateOne(
                        { _id: new Types.ObjectId(admin.id) },
                        { $set: { locked_until: new Date(Date.now() - 1000) } },
                    );
            const lockWindowSeconds = async () => {
                const stored = await fx.collection<{ locked_until: Date }>('User').findById(admin.id).lean();

                return Math.round((stored!.locked_until.getTime() - Date.now()) / 1000);
            };

            for (let attempt = 0; attempt < config.auth.maxFailedAttempts; attempt += 1) {
                await login(admin, 'wrong-password');
            }

            expect(await lockWindowSeconds()).toBeCloseTo(60, -1);

            // An attacker who waits out the lock and tries again gets a longer one, not another minute.
            await expireLock();
            await login(admin, 'wrong-password');
            expect(await lockWindowSeconds()).toBeCloseTo(120, -1);

            for (let cycle = 0; cycle < 4; cycle += 1) {
                await expireLock();
                await login(admin, 'wrong-password');
            }

            expect(await lockWindowSeconds()).toBeLessThanOrEqual(240);
        });

        it('lets the budget decay, so a wrong password once per window cannot lock an account for ever', async () => {
            config.auth.failedAttemptWindowSeconds = 300;
            const admin = await fx.superAdmin();
            const stored = () =>
                fx
                    .collection<{ failed_login_attempts: number; locked_until?: Date }>('User')
                    .findById(admin.id)
                    .lean();

            for (let attempt = 0; attempt < config.auth.maxFailedAttempts; attempt += 1) {
                await login(admin, 'wrong-password');
            }

            expect((await stored())!.failed_login_attempts).toBe(3);

            // The attacker waits out the lock — and past the window, which is the whole point.
            await fx.collection('User').updateOne(
                { _id: new Types.ObjectId(admin.id) },
                {
                    $set: {
                        locked_until: new Date(Date.now() - 1000),
                        last_failed_login_at: new Date(Date.now() - 10 * 60 * 1000),
                    },
                },
            );
            await login(admin, 'wrong-password');

            // The count starts over instead of escalating, so this failure locks nothing.
            const after = await stored();
            expect(after!.failed_login_attempts).toBe(1);
            expect(after!.locked_until!.getTime()).toBeLessThan(Date.now());
            expect((await login(admin, admin.password!)).status).toBe(200);
        });

        it('a successful login clears the counter, and an expired lock lets the account back in', async () => {
            const admin = await fx.superAdmin();
            await login(admin, 'wrong-password');
            await login(admin, 'wrong-password');
            expect((await login(admin, admin.password!)).status).toBe(200);
            expect(
                (await fx.collection<{ failed_login_attempts: number }>('User').findById(admin.id).lean())!
                    .failed_login_attempts,
            ).toBe(0);

            for (let attempt = 0; attempt < 3; attempt += 1) await login(admin, 'wrong-password');

            expectError(await login(admin, admin.password!), 401, 'INVALID_CREDENTIALS');
            await fx
                .collection('User')
                .updateOne(
                    { _id: new Types.ObjectId(admin.id) },
                    { $set: { locked_until: new Date(Date.now() - 1000) } },
                );
            expect((await login(admin, admin.password!)).status).toBe(200);
        });
    });

    describe('global sms budget', () => {
        it('refuses further messages once the hourly budget is spent and records the refusal', async () => {
            const superAdmin = await fx.superAdmin();
            const bearer = await fx.bearer(superAdmin);
            config.sms.budget.hourlyLimit = 2;

            for (let sent = 0; sent < 2; sent += 1) {
                const res = await t.http
                    .post(`${t.prefix}/sms/test`)
                    .set('Authorization', bearer)
                    .send({ phone: '375291112233' });
                expect(res.status).toBe(200);
            }

            expectError(
                await t.http
                    .post(`${t.prefix}/sms/test`)
                    .set('Authorization', bearer)
                    .send({ phone: '375291112233' }),
                422,
                'SMS_BUDGET_EXCEEDED',
            );
            expect(smsProvider).toHaveBeenCalledTimes(2);
            expect(await fx.collection('Sms').countDocuments({ status: 'blocked' })).toBe(1);
            const metrics = await t.http.get(`${t.prefix}/metrics`).set('Authorization', bearer);
            expect(metrics.text).toMatch(/sms_budget_blocked_total\{[^}]*window="hour"[^}]*\} [1-9]/);
        });

        it('holds the cap across senders: an exhausted budget also stops one-time codes', async () => {
            config.sms.budget.dailyLimit = 1;
            const superAdmin = await fx.superAdmin();
            await t.http
                .post(`${t.prefix}/sms/test`)
                .set('Authorization', await fx.bearer(superAdmin))
                .send({ phone: '375291112233' });

            // The OTP route swallows delivery problems so that it cannot be used to probe for accounts.
            const otp = await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '375291112244' });
            expect(otp.status).toBe(200);
            expect(smsProvider).toHaveBeenCalledTimes(1);
            await waitFor(async () => (await fx.collection('Sms').countDocuments({ status: 'blocked' })) > 0);
        });
    });

    describe('personal data lifetime', () => {
        it('does not record the phone of an anonymous one-time code request', async () => {
            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: '375291112255' });
            const event = await waitFor(() =>
                fx
                    .collection<{ user_phone?: string; user_name?: string }>('AnalyticsEvent')
                    .findOne({ type: 'auth.otp_requested' })
                    .lean(),
            );
            expect(event!.user_phone).toBeUndefined();
            expect(event!.user_name).toBeUndefined();
        });

        it('anonymises the analytics of a deleted account instead of leaving its name and phone behind', async () => {
            const organization = await fx.organization();
            const superAdmin = await fx.superAdmin();
            const client = await fx.client({ name: 'Anna', phone: '375291112266' });
            await t.http
                .get(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', await fx.bearer(client));
            await waitFor(
                async () =>
                    (await fx
                        .collection('AnalyticsEvent')
                        .countDocuments({ user_id: new Types.ObjectId(client.id) })) > 0,
            );

            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/users/${client.id}`)
                        .set('Authorization', await fx.bearer(superAdmin))
                ).status,
            ).toBe(204);

            expect(
                await fx
                    .collection('AnalyticsEvent')
                    .countDocuments({ user_id: new Types.ObjectId(client.id) }),
            ).toBe(0);
            const events = await fx
                .collection<{ user_name?: string; user_phone?: string }>('AnalyticsEvent')
                .find({})
                .lean();
            expect(events.length).toBeGreaterThan(0);
            expect(events.some((event) => event.user_name || event.user_phone)).toBe(false);
        });
    });
});
