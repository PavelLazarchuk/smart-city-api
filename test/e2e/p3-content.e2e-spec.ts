import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('news, organizations, rate-limit headers and OpenAPI errors (e2e)', () => {
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

    describe('news', () => {
        const create = (body: Record<string, unknown>) =>
            t.http
                .post(`${t.prefix}/news`)
                .set('Authorization', bearer)
                .send({ organization_id: organization.id, ...body });

        it('has slugs, rubrics, scheduled publication and full-text search', async () => {
            const first = await create({
                label: 'Opening hours changed',
                rubric: 'announcements',
                enabled: true,
                value: { text_value: 'We open at eight.' },
            });
            expect(first.status).toBe(201);
            expect(first.body.data).toMatchObject({
                slug: 'opening-hours-changed',
                rubric: 'announcements',
                publish_at: null,
            });
            expect((await create({ label: 'Opening hours changed', enabled: true })).body.data.slug).toBe(
                'opening-hours-changed-2',
            );
            expectError(await create({ label: 'x', slug: 'opening-hours-changed' }), 409, 'NEWS_SLUG_TAKEN');

            const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            const scheduled = await create({
                label: 'Tomorrow',
                rubric: 'events',
                enabled: true,
                publish_at: future,
            });
            expect(scheduled.status).toBe(201);
            const scheduledId = scheduled.body.data.id as string;

            const publicList = await t.http.get(`${t.prefix}/news`);
            expect(publicList.body.data.map((item: { id: string }) => item.id)).not.toContain(scheduledId);
            expectError(await t.http.get(`${t.prefix}/news/${scheduledId}`), 404, 'NEWS_NOT_FOUND');
            const adminList = await t.http.get(`${t.prefix}/news`).set('Authorization', bearer);
            expect(adminList.body.data.map((item: { id: string }) => item.id)).toContain(scheduledId);
            expect(
                (await t.http.get(`${t.prefix}/news/${scheduledId}`).set('Authorization', bearer)).status,
            ).toBe(200);

            const published = await t.http
                .patch(`${t.prefix}/news/${scheduledId}`)
                .set('Authorization', bearer)
                .send({ publish_at: new Date(Date.now() - 1000).toISOString() });
            expect(published.status).toBe(200);
            expect((await t.http.get(`${t.prefix}/news/${scheduledId}`)).status).toBe(200);

            const byRubric = await t.http.get(`${t.prefix}/news?rubric=events`);
            expect(byRubric.body.data.map((item: { id: string }) => item.id)).toEqual([scheduledId]);
            const byText = await t.http.get(`${t.prefix}/news?q=eight`);
            expect(byText.body.data.map((item: { id: string }) => item.id)).toEqual([first.body.data.id]);

            const bySlug = await t.http.get(
                `${t.prefix}/organizations/${organization.id}/news/opening-hours-changed`,
            );
            expect(bySlug.status).toBe(200);
            expect(bySlug.body.data.id).toBe(first.body.data.id);
        });

        it('serves an RSS 2.0 feed of the enabled, published items with escaped text', async () => {
            await create({
                label: 'Fish & chips <night>',
                enabled: true,
                rubric: 'events',
                value: { text_value: 'Come "early"' },
            });
            await create({ label: 'Disabled', enabled: false });
            await create({
                label: 'Later',
                enabled: true,
                publish_at: new Date(Date.now() + 60_000).toISOString(),
            });
            await fx.news((await fx.organization()).id, { label: 'Elsewhere' });

            const res = await t.http.get(`${t.prefix}/news/rss?organization_id=${organization.id}`);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('application/rss+xml');
            expect(res.headers['cache-control']).toBe('public, max-age=300');
            expect(res.text).toContain('<rss version="2.0">');
            expect(res.text).toContain('<title>Fish &amp; chips &lt;night&gt;</title>');
            expect(res.text).toContain('<description>Come &quot;early&quot;</description>');
            expect(res.text).toContain('<category>events</category>');
            expect(res.text).toContain(
                `https://city.example.com/organizations/${organization.id}/news/fish-chips-night`,
            );
            expect(res.text).not.toContain('Disabled');
            expect(res.text).not.toContain('Later');
            expect(res.text).not.toContain('Elsewhere');
            expect((res.text.match(/<item>/g) ?? []).length).toBe(1);

            const all = await t.http.get(`${t.prefix}/news/rss`);
            expect((all.text.match(/<item>/g) ?? []).length).toBe(2);
        });
    });

    describe('organizations', () => {
        it('stores working hours, holidays, address, location and the temporary closure', async () => {
            const res = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', bearer)
                .send({
                    status: 'temporarily_closed',
                    closed_reason: 'Renovation',
                    closed_until: '2030-01-01T00:00:00.000Z',
                    address: '2 Side Street',
                    location: { lng: 27.5, lat: 53.9 },
                    working_hours: [{ day: 'tuesday', from: '08:00', to: '20:00' }],
                    holidays: ['01-01'],
                });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
                status: 'temporarily_closed',
                closed_reason: 'Renovation',
                closed_until: '2030-01-01T00:00:00.000Z',
                address: '2 Side Street',
                location: { type: 'Point', coordinates: [27.5, 53.9] },
                working_hours: [{ day: 'tuesday', from: '08:00', to: '20:00' }],
                holidays: ['01-01'],
            });
            const closed = await t.http.get(`${t.prefix}/organizations?status=temporarily_closed`);
            expect(closed.body.data.map((item: { id: string }) => item.id)).toEqual([organization.id]);
            expect((await t.http.get(`${t.prefix}/organizations?status=active`)).body.data).toHaveLength(0);

            const reopened = await t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', bearer)
                .send({ status: 'active', closed_reason: null, closed_until: null, location: null });
            expect(reopened.body.data).toMatchObject({ status: 'active', closed_until: null });
            expect(reopened.body.data.closed_reason).toBeUndefined();
            expect(reopened.body.data.location).toBeUndefined();
            expectError(
                await t.http
                    .patch(`${t.prefix}/organizations/${organization.id}`)
                    .set('Authorization', bearer)
                    .send({ status: 'closed' }),
                400,
                'VALIDATION_ERROR',
            );
        });
    });

    describe('rate-limit headers', () => {
        it('sends the IETF RateLimit fields next to the legacy X-RateLimit ones', async () => {
            const res = await t.http.get(`${t.prefix}/organizations`);
            expect(res.status).toBe(200);
            expect(res.headers['ratelimit-limit']).toBe(String(t.config.throttle.globalLimit));
            expect(Number(res.headers['ratelimit-remaining'])).toBeLessThan(t.config.throttle.globalLimit);
            expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
            expect(res.headers['ratelimit-policy']).toBe(
                `${t.config.throttle.globalLimit};w=${t.config.throttle.ttlSeconds}`,
            );
            expect(res.headers['x-ratelimit-limit-global']).toBe(String(t.config.throttle.globalLimit));

            const auth = await t.http.post(`${t.prefix}/auth/login`).send({ login: 'nobody', password: 'x' });
            expect(auth.headers['ratelimit-limit']).toBe(String(t.config.throttle.limit));
        });
    });

    describe('OpenAPI', () => {
        it('documents the error envelope and the codes of every operation', async () => {
            const res = await t.http.get('/api/docs-json');
            expect(res.status).toBe(200);
            const document = res.body as {
                components: {
                    schemas: Record<
                        string,
                        { properties: { error: { properties: { code: { enum: string[] } } } } }
                    >;
                };
                paths: Record<
                    string,
                    Record<string, { responses: Record<string, { description: string; content: unknown }> }>
                >;
            };
            const envelope = document.components.schemas['ErrorEnvelope']!;
            expect(envelope.properties.error.properties.code.enum).toContain('SLOT_FULL');

            const booking = document.paths[`${t.prefix}/services/{id}/bookings`]!['post']!;
            expect(booking.responses['422']!.description).toContain('`SLOT_FULL`');
            expect(booking.responses['422']!.description).toContain('`BOOKING_LEAD_TIME`');
            expect(booking.responses['409']!.description).toContain('`BOOKING_ALREADY_EXISTS`');
            expect(booking.responses['401']!.description).toContain('`UNAUTHENTICATED`');
            expect(booking.responses['429']!.description).toContain('`RATE_LIMITED`');
            expect(booking.responses['500']!.content).toBeDefined();

            const publicList = document.paths[`${t.prefix}/services`]!['get']!;
            expect(publicList.responses['400']!.description).toContain('`FIELDS_NOT_ALLOWED`');
            expect(publicList.responses['401']).toBeUndefined();
        });
    });
});
