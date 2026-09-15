import { JwtService } from '@nestjs/jwt';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

import { AppConfig } from '../../src/common/config/app-config';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('tokens, sessions, password policy and uploads (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let config: AppConfig;
    let jwt: JwtService;
    let admin: FixtureUser;
    let organization: { id: string };

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        config = t.app.get(AppConfig);
        jwt = t.app.get(JwtService);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
    });

    describe('access tokens', () => {
        const me = (token: string) =>
            t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${token}`);

        it('carries issuer, audience and a key id, and refuses a token from another deployment', async () => {
            const { access } = await fx.token(admin);
            const decoded = jwt.decode<{ iss: string; aud: string }>(access);
            expect(decoded.iss).toBe(config.auth.issuer);
            expect(decoded.aud).toBe(config.auth.audience);
            expect(jwt.decode(access, { complete: true }).header.kid).toBe(config.auth.access.kid);
            expect((await me(access)).status).toBe(200);

            const foreign = await jwt.signAsync(
                { sub: admin.id, sid: '000000000000000000000000', role: admin.role, type: 'access' },
                {
                    secret: config.auth.access.secret,
                    issuer: 'staging-api',
                    audience: config.auth.audience,
                    expiresIn: 60,
                },
            );
            expectError(await me(foreign), 401, 'TOKEN_INVALID');
        });

        it('keeps accepting a token signed with a retired key, and refuses an unknown one', async () => {
            const retired = 'r'.repeat(32);
            const { sid } = await fx.token(admin);
            config.auth.access.accepted['retired'] = retired;

            const rotated = await jwt.signAsync(
                { sub: admin.id, sid, role: admin.role, type: 'access' },
                {
                    secret: retired,
                    keyid: 'retired',
                    issuer: config.auth.issuer,
                    audience: config.auth.audience,
                    expiresIn: 60,
                },
            );
            expect((await me(rotated)).status).toBe(200);

            delete config.auth.access.accepted['retired'];
            expectError(await me(rotated), 401, 'TOKEN_INVALID');
        });

        it('answers 401 to a malformed refresh token instead of failing while reading its header', async () => {
            for (const token of ['not-a-token', 'eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.sig', '..']) {
                expectError(
                    await t.http.post(`${t.prefix}/auth/refresh`).send({ refresh_token: token }),
                    401,
                    'TOKEN_INVALID',
                );
            }
        });
    });

    describe('GET /auth/sessions and DELETE /auth/sessions/:sid', () => {
        it('lists the account’s own devices and signs one of them out', async () => {
            const first = await fx.token(admin);
            const second = await fx.token(admin);

            const listed = await t.http
                .get(`${t.prefix}/auth/sessions`)
                .set('Authorization', `Bearer ${second.access}`);
            expect(listed.status).toBe(200);
            expect(listed.body.data).toHaveLength(2);
            expect(listed.body.data.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
            expect(listed.body.data.find((row: { id: string }) => row.id === second.sid).current).toBe(true);
            expect(JSON.stringify(listed.body)).not.toContain('refresh_token_hash');

            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/auth/sessions/${first.sid}`)
                        .set('Authorization', `Bearer ${second.access}`)
                ).status,
            ).toBe(204);
            expectError(
                await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${first.access}`),
                401,
                'SESSION_REVOKED',
            );
            expect(
                (
                    await t.http
                        .get(`${t.prefix}/auth/sessions`)
                        .set('Authorization', `Bearer ${second.access}`)
                ).body.data,
            ).toHaveLength(1);
        });

        it('cannot revoke someone else’s session', async () => {
            const mine = await fx.token(admin);
            const theirs = await fx.token(await fx.admin([organization.id]));

            expectError(
                await t.http
                    .delete(`${t.prefix}/auth/sessions/${theirs.sid}`)
                    .set('Authorization', `Bearer ${mine.access}`),
                404,
                'SESSION_NOT_FOUND',
            );
            expect(
                (await t.http.get(`${t.prefix}/auth/me`).set('Authorization', `Bearer ${theirs.access}`))
                    .status,
            ).toBe(200);
            expectError(await t.http.delete(`${t.prefix}/auth/sessions/${mine.sid}`), 401);
        });
    });

    describe('password policy', () => {
        const change = async (password: string) =>
            t.http
                .patch(`${t.prefix}/auth/password`)
                .set('Authorization', await fx.bearer(admin))
                .send({
                    current_password: admin.password,
                    new_password: password,
                    new_password_confirmation: password,
                });

        it('asks for 8–20 characters with a lowercase, an uppercase, a digit and a special character', async () => {
            expectError(await change('Ab1!def'), 422, 'PASSWORD_TOO_SHORT');
            expectError(await change(`Ab1!${'x'.repeat(20)}`), 422, 'PASSWORD_TOO_LONG');

            const weak = await change('abcdefgh1');
            expectError(weak, 422, 'PASSWORD_TOO_WEAK');
            expect(weak.body.error.details.map((detail: { message: string }) => detail.message)).toEqual([
                'At least one uppercase latin letter',
                'At least one special character',
            ]);

            expect((await change('Str0ng-Passw0rd')).status).toBe(204);
            expect(
                (
                    await t.http
                        .post(`${t.prefix}/auth/login`)
                        .send({ login: admin.login, password: 'Str0ng-Passw0rd' })
                ).status,
            ).toBe(200);
        });

        it('applies to accounts a super-admin creates', async () => {
            expectError(
                await t.http
                    .post(`${t.prefix}/users`)
                    .set('Authorization', await fx.bearer(await fx.superAdmin()))
                    .send({ login: 'weakadmin', password: 'weakpassword', role: 'common-admin' }),
                422,
                'PASSWORD_TOO_WEAK',
            );
        });
    });

    describe('image uploads', () => {
        const upload = async (bytes: Buffer, contentType = 'image/jpeg') =>
            t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', await fx.bearer(admin))
                .attach('file', bytes, { filename: 'photo.jpg', contentType });

        it('strips EXIF by re-encoding the file that gets stored', async () => {
            const withExif = await sharp({
                create: { width: 32, height: 32, channels: 3, background: '#336699' },
            })
                .withExif({ IFD0: { Copyright: 'exif-marker-1234' } })
                .jpeg()
                .toBuffer();
            expect(withExif.includes('exif-marker-1234')).toBe(true);

            const res = await upload(withExif);
            expect(res.status).toBe(201);
            const stored = await sharp(
                readFileSync(`${t.config.storage.local.dir}/${res.body.data.name as string}`),
            ).metadata();
            expect(stored.exif).toBeUndefined();
            expect(stored.width).toBe(32);
        });

        it('refuses an image whose decoded resolution is over the limit', async () => {
            const image = await sharp({
                create: { width: 64, height: 64, channels: 3, background: '#ffffff' },
            })
                .jpeg()
                .toBuffer();

            const pixels = t.config.upload.maxPixels;
            t.config.upload.maxPixels = 1024;
            try {
                expectError(await upload(image), 422, 'IMAGE_TOO_LARGE');
            } finally {
                t.config.upload.maxPixels = pixels;
            }

            expect((await upload(image)).status).toBe(201);
        });

        it('refuses bytes that pass the magic-byte check but do not decode', async () => {
            const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
            expectError(await upload(broken), 400, 'IMAGE_UNREADABLE');
        });
    });
    describe('response headers', () => {
        it('locks down the API with a content security policy and same-origin resource policy', async () => {
            const res = await t.http.get(`${t.prefix}/organizations`);
            expect(res.status).toBe(200);
            expect(res.headers['content-security-policy']).toContain("default-src 'none'");
            expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
            expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
            expect(res.headers['referrer-policy']).toBe('no-referrer');
        });

        it('serves the Swagger UI under a policy that allows its own scripts', async () => {
            const res = await t.http.get('/api/docs');
            expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
        });

        it('marks authenticated responses private and keeps them out of search indexes', async () => {
            const res = await t.http.get(`${t.prefix}/auth/me`).set('Authorization', await fx.bearer(admin));
            expect(res.status).toBe(200);
            expect(res.headers['cache-control']).toBe('private, no-store, max-age=0');
            expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
            expect(res.headers['vary']).toContain('Authorization');
        });

        it('treats a public route answered for a signed-in caller as private too', async () => {
            const anonymous = await t.http.get(`${t.prefix}/organizations`);
            expect(anonymous.headers['cache-control']).toBeUndefined();
            expect(anonymous.headers['x-robots-tag']).toBeUndefined();

            const signed = await t.http
                .get(`${t.prefix}/organizations`)
                .set('Authorization', await fx.bearer(admin));
            expect(signed.headers['cache-control']).toBe('private, no-store, max-age=0');
            expect(signed.headers['x-robots-tag']).toBe('noindex, nofollow');
        });

        it('shares uploads only with allow-listed origins', async () => {
            const image = await sharp({
                create: { width: 16, height: 16, channels: 3, background: '#112233' },
            })
                .jpeg()
                .toBuffer();
            const created = await t.http
                .post(`${t.prefix}/organizations/${organization.id}/images`)
                .set('Authorization', await fx.bearer(admin))
                .attach('file', image, { filename: 'photo.jpg', contentType: 'image/jpeg' });
            expect(created.status).toBe(201);
            const path = `/uploads/${created.body.data.name as string}`;

            const [allowedOrigin = ''] = t.config.storage.corsOrigins;
            const allowed = await t.http.get(path).set('Origin', allowedOrigin);
            expect(allowed.status).toBe(200);
            expect(allowed.headers['cross-origin-resource-policy']).toBe('cross-origin');
            expect(allowed.headers['access-control-allow-origin']).toBe(allowedOrigin);
            expect(allowed.headers['cache-control']).toBe(
                `public, max-age=${t.config.storage.cacheMaxAgeSeconds}`,
            );

            const foreign = await t.http.get(path).set('Origin', 'https://evil.example.com');
            expect(foreign.headers['cross-origin-resource-policy']).toBe('same-origin');
            expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
        });
    });
});
