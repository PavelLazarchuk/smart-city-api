import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

import { SETTINGS_DOCUMENT_ID } from '../../src/common/settings/schemas/settings.schema';
import { SETTING_KEYS } from '../../src/common/settings/settings.registry';
import { SettingsService } from '../../src/common/settings/settings.service';
import { expectError } from '../support/assertions';
import { type FixtureUser, Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

interface SettingRow {
    key: string;
    value: unknown;
    source: string;
    env_value: unknown;
}

describe('runtime settings (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let owner: FixtureUser;
    let bearer: string;

    const path = (key = '') => `${t.prefix}/settings${key ? `/${key}` : ''}`;
    const patch = (values: Record<string, unknown>, ifMatch?: string) => {
        const req = t.http.patch(path()).set('Authorization', bearer);

        return (ifMatch ? req.set('If-Match', ifMatch) : req).send({ values });
    };
    const row = (body: { data: { items: SettingRow[] } }, key: string): SettingRow | undefined =>
        body.data.items.find((item) => item.key === key);
    const stored = () => t.connection.collection('settings').findOne({ _id: SETTINGS_DOCUMENT_ID });

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        await t.app.get(SettingsService).refresh();
        owner = await fx.superAdmin();
        bearer = await fx.bearer(owner);
    });

    it('lists every registered key with the environment value until it is overridden', async () => {
        const res = await t.http.get(path()).set('Authorization', bearer);

        expect(res.status).toBe(200);
        expect(res.headers['etag']).toBe('"0"');
        expect(res.body.data.updated_at).toBeNull();
        expect(res.body.data.items.map((item: SettingRow) => item.key)).toEqual(SETTING_KEYS);
        expect(row(res.body, 'auth.client_login_method')).toMatchObject({
            group: 'auth',
            value: 'sms',
            source: 'env',
            env_value: 'sms',
            schema: { type: 'string', enum: ['password', 'sms'] },
        });
        expect(row(res.body, 'upload.max_bytes')).toMatchObject({
            value: t.config.upload.maxBytes,
            schema: { type: 'integer', minimum: 1024, maximum: t.config.upload.maxBytes },
        });
    });

    it('reads one key and refuses unknown ones', async () => {
        const one = await t.http.get(path('otp.length')).set('Authorization', bearer);
        expect(one.status).toBe(200);
        expect(one.body.data).toMatchObject({ key: 'otp.length', value: 6, source: 'env' });

        expectError(
            await t.http.get(path('jwt.secret')).set('Authorization', bearer),
            404,
            'SETTING_NOT_FOUND',
        );
    });

    it('is reserved for super admins', async () => {
        const organization = await fx.organization();
        const admin = await fx.bearer(await fx.admin([organization.id]));

        expectError(await t.http.get(path()).set('Authorization', admin), 403);
        expectError(
            await t.http
                .patch(path())
                .set('Authorization', admin)
                .send({ values: { 'otp.length': 8 } }),
            403,
        );
        expectError(await t.http.get(path()), 401);
    });

    it('stores only overrides, nested by group, in a single document', async () => {
        const res = await patch({ 'auth.lockout_seconds': 600, 'otp.length': 8 });

        expect(res.status).toBe(200);
        expect(row(res.body, 'auth.lockout_seconds')).toMatchObject({
            value: 600,
            source: 'db',
            env_value: 300,
        });
        expect(res.headers['etag']).toBe(`"${new Date(res.body.data.updated_at as string).getTime()}"`);
        expect(await t.connection.collection('settings').countDocuments()).toBe(1);
        expect(await stored()).toMatchObject({
            settings: { auth: { lockout_seconds: 600 }, otp: { length: 8 } },
            updated_at: expect.any(Date),
        });
    });

    it('switches the client login method without a restart', async () => {
        const body = { phone: '4915291112233', password: 'Client-Pass1', name: 'New' };
        expectError(await t.http.post(`${t.prefix}/auth/register`).send(body), 403, 'LOGIN_METHOD_DISABLED');

        expect((await patch({ 'auth.client_login_method': 'password' })).status).toBe(200);

        expect((await t.http.post(`${t.prefix}/auth/register`).send(body)).status).toBe(201);
    });

    it('applies a new throttle limit to the next request', async () => {
        expect((await patch({ 'throttle.limit': 50 })).status).toBe(200);

        const res = await t.http.post(`${t.prefix}/auth/login`).send({ login: 'nobody', password: 'wrong' });

        expect(res.headers['ratelimit-limit']).toBe('50');
    });

    it('enforces a lowered upload limit', async () => {
        const noise = await sharp(randomBytes(64 * 64 * 3), { raw: { width: 64, height: 64, channels: 3 } })
            .jpeg({ quality: 100 })
            .toBuffer();
        const organization = await fx.organization();
        expect(noise.length).toBeGreaterThan(1024);

        expect((await patch({ 'upload.max_bytes': 1024 })).status).toBe(200);

        const res = await t.http
            .post(`${t.prefix}/organizations/${organization.id}/images`)
            .set('Authorization', bearer)
            .attach('file', noise, { filename: 'noise.jpg', contentType: 'image/jpeg' });
        expectError(res, 400, 'FILE_TOO_LARGE');
    });

    it('rejects the whole change when one value is invalid', async () => {
        const res = await patch({ 'otp.length': 8, 'otp.ttl_seconds': 5, 'jwt.secret': 'x' });

        expectError(res, 422, 'SETTINGS_INVALID');
        expect(res.body.error.details.map((detail: { path: string }) => detail.path).sort()).toEqual([
            'jwt.secret',
            'otp.ttl_seconds',
        ]);
        expect(await stored()).toBeNull();
        expect(t.app.get(SettingsService).get('otp.length')).toBe(6);
    });

    it('checks cross-key rules on the resulting values', async () => {
        expect((await patch({ 'auth.lockout_max_seconds': 600 })).status).toBe(200);

        const res = await patch({ 'auth.lockout_seconds': 900 });
        expectError(res, 422, 'SETTINGS_INVALID');
        expect(res.body.error.details).toEqual([
            { path: 'auth.lockout_max_seconds', message: expect.any(String) },
        ]);

        expect((await patch({ 'auth.lockout_seconds': 900, 'auth.lockout_max_seconds': 1800 })).status).toBe(
            200,
        );
    });

    it('resets a key to the environment value and drops the emptied group', async () => {
        await patch({ 'otp.length': 8, 'auth.lockout_seconds': 600 });

        const reset = await t.http.delete(path('otp.length')).set('Authorization', bearer);
        expect(reset.status).toBe(200);
        expect(row(reset.body, 'otp.length')).toMatchObject({ value: 6, source: 'env' });

        const one = await t.http.get(path('otp.length')).set('Authorization', bearer);
        expect(one.body.data).toMatchObject({ value: 6, source: 'env' });
        const document = await stored();
        expect(document?.['settings']).toEqual({ auth: { lockout_seconds: 600 } });
        expect(reset.headers['etag']).toBe(`"${(document?.['updated_at'] as Date).getTime()}"`);

        expect((await patch({ 'otp.length': 9 })).status).toBe(200);
        expect(t.app.get(SettingsService).get('otp.length')).toBe(9);
    });

    it('leaves the document alone when a reset changes nothing', async () => {
        const saved = await patch({ 'otp.length': 8 });

        const reset = await t.http.delete(path('auth.lockout_seconds')).set('Authorization', bearer);

        expect(reset.status).toBe(200);
        expect(reset.headers['etag']).toBe(saved.headers['etag']);
        expect((await stored())?.['updated_at']).toEqual(new Date(saved.body.data.updated_at as string));
    });

    it('overwrites a stored value that no longer passes its schema', async () => {
        await t.connection.collection('settings').insertOne({
            _id: SETTINGS_DOCUMENT_ID,
            settings: { otp: { length: 99 }, auth: 5 },
            updated_at: new Date(),
        });
        await t.app.get(SettingsService).refresh();

        expect((await patch({ 'otp.length': 8, 'auth.lockout_seconds': 600 })).status).toBe(200);
        expect((await stored())?.['settings']).toEqual({
            otp: { length: 8 },
            auth: { lockout_seconds: 600 },
        });
    });

    it('refuses a write based on a stale ETag', async () => {
        const first = await t.http.get(path()).set('Authorization', bearer);
        const tag = first.headers['etag'] as string;

        const saved = await patch({ 'otp.length': 8 }, tag);
        expect(saved.status).toBe(200);

        expectError(await patch({ 'otp.length': 7 }, tag), 409, 'SETTINGS_CONFLICT');
        expectError(
            await t.http.delete(path('otp.length')).set('Authorization', bearer).set('If-Match', tag),
            409,
            'SETTINGS_CONFLICT',
        );
        expect((await patch({ 'otp.length': 7 }, saved.headers['etag'] as string)).status).toBe(200);
    });

    it('picks up a change written by another instance and ignores invalid stored values', async () => {
        await t.connection.collection('settings').insertOne({
            _id: SETTINGS_DOCUMENT_ID,
            settings: { otp: { length: 99, max_attempts: 4 }, legacy: { flag: true } },
            updated_at: new Date(),
        });
        const settings = t.app.get(SettingsService);
        await settings.refresh();

        expect(settings.get('otp.length')).toBe(6);
        expect(settings.get('otp.max_attempts')).toBe(4);

        expect((await patch({ 'otp.ttl_seconds': 600 })).status).toBe(200);
        expect((await stored())?.['settings']).toEqual({
            otp: { length: 99, max_attempts: 4, ttl_seconds: 600 },
            legacy: { flag: true },
        });

        expect((await t.http.delete(path('otp.length')).set('Authorization', bearer)).status).toBe(200);
        expect((await stored())?.['settings']).toEqual({
            otp: { max_attempts: 4, ttl_seconds: 600 },
            legacy: { flag: true },
        });
    });

    describe('sign-in protection', () => {
        it('refuses SMS staff login while the acting super admin has no phone', async () => {
            const res = await patch({ 'auth.admin_login_method': 'sms' });

            expectError(res, 409, 'SETTING_LOCKOUT_RISK');
        });

        it('refuses SMS staff login when no other super admin has a phone', async () => {
            const self = await fx.user({ role: 'super-admin', phone: '4915290000001' });
            bearer = await fx.bearer(self);

            expectError(await patch({ 'auth.admin_login_method': 'sms' }), 409, 'SETTING_LOCKOUT_RISK');
        });

        it('switches to SMS and lists the staff left without a way in', async () => {
            const self = await fx.user({ role: 'super-admin', phone: '4915290000001' });
            await fx.user({ role: 'super-admin', phone: '4915290000002' });
            bearer = await fx.bearer(self);

            const res = await patch({ 'auth.admin_login_method': 'sms' });

            expect(res.status).toBe(200);
            expect(res.body.data.warnings).toEqual([
                { code: 'STAFF_CANNOT_SIGN_IN', message: expect.any(String), user_ids: [owner.id] },
            ]);
        });

        it('refuses password staff login while the acting super admin has no password', async () => {
            const self = await fx.user({ role: 'super-admin', phone: '4915290000001' });
            bearer = await fx.bearer(self);
            await t.connection.collection('settings').insertOne({
                _id: SETTINGS_DOCUMENT_ID,
                settings: { auth: { admin_login_method: 'sms' } },
                updated_at: new Date(),
            });
            await t.app.get(SettingsService).refresh();
            await t.connection
                .collection('users')
                .updateOne({ login: self.login }, { $unset: { password_hash: '' } });

            expectError(await patch({ 'auth.admin_login_method': 'password' }), 409, 'SETTING_LOCKOUT_RISK');
        });
    });
});

describe('runtime settings with SETTINGS_IGNORE_DB (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        process.env['SETTINGS_IGNORE_DB'] = 'true';
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(async () => {
        delete process.env['SETTINGS_IGNORE_DB'];
        await t.close();
    });

    it('serves the environment and refuses writes', async () => {
        await t.connection.collection('settings').insertOne({
            _id: SETTINGS_DOCUMENT_ID,
            settings: { otp: { length: 8 } },
            updated_at: new Date(),
        });
        await t.app.get(SettingsService).refresh();
        const bearer = await fx.bearer(await fx.superAdmin());

        const list = await t.http.get(`${t.prefix}/settings/otp.length`).set('Authorization', bearer);
        expect(list.body.data).toMatchObject({ value: 6, source: 'env' });

        const res = await t.http
            .patch(`${t.prefix}/settings`)
            .set('Authorization', bearer)
            .send({ values: { 'otp.length': 8 } });
        expectError(res, 409, 'SETTINGS_READ_ONLY');
    });
});
