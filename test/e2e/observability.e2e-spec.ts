import { Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { JobRunner } from '../../src/jobs/job-runner';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('observability (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let config: AppConfig;
    let superAdmin: FixtureUser;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        config = t.app.get(AppConfig);
        superAdmin = await fx.superAdmin();
    });
    afterAll(() => t.close());
    afterEach(() => {
        config.metrics.enabled = true;
        config.metrics.token = undefined;
    });

    const scrape = async () =>
        t.http.get(`${t.prefix}/metrics`).set('Authorization', await fx.bearer(superAdmin));

    describe('health', () => {
        it('separates readiness from the full dependency sweep and reports the build', async () => {
            const ready = await t.http.get(`${t.prefix}/health/ready`);
            expect(ready.status).toBe(200);
            expect(Object.keys(ready.body.info)).toEqual(['mongodb']);

            const deps = await t.http.get(`${t.prefix}/health/deps`);
            expect(deps.status).toBe(200);
            expect(deps.body.info.mongodb.status).toBe('up');
            expect(deps.body.info.storage.status).toBe('up');
            expect(deps.body.info.mail.status).toBe('up');

            const info = await t.http.get(`${t.prefix}/health/info`);
            expect(info.status).toBe(200);
            expect(info.body.data).toMatchObject({ env: 'test', commit: null });
            expect(typeof info.body.data.version).toBe('string');
            expect(typeof info.body.data.started_at).toBe('string');
            expect(info.body.data.uptime_seconds).toBeGreaterThanOrEqual(0);
        });

        it('reports a failing dependency as down without failing readiness, and keeps the cause private', async () => {
            const storage = t.app.get<{ check: () => Promise<void> }>(
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                (require('../../src/integrations/storage/storage.provider') as { STORAGE_PROVIDER: symbol })
                    .STORAGE_PROVIDER,
            );
            const spy = jest
                .spyOn(storage, 'check')
                .mockRejectedValue(new Error('bucket smart-city-prod unreachable at minio.internal:9000'));

            // An anonymous caller learns which dependency is down — never the host it could not reach.
            const deps = await t.http.get(`${t.prefix}/health/deps`);
            expectError(deps, 503, 'DEPENDENCY_UNAVAILABLE');
            expect(deps.body.error.details).toEqual([{ path: 'storage', message: 'down' }]);
            expect(JSON.stringify(deps.body)).not.toContain('minio.internal');

            const asSuperAdmin = await t.http
                .get(`${t.prefix}/health/deps`)
                .set('Authorization', await fx.bearer(superAdmin));
            expectError(asSuperAdmin, 503, 'DEPENDENCY_UNAVAILABLE');
            expect(asSuperAdmin.body.error.details).toEqual([
                { path: 'storage', message: 'bucket smart-city-prod unreachable at minio.internal:9000' },
            ]);

            expect((await t.http.get(`${t.prefix}/health/ready`)).status).toBe(200);
            spy.mockRestore();
        });

        it('serves the last outcome of every job to a super-admin only', async () => {
            const runner = t.app.get(JobRunner);
            await runner.run('demo_ok', () => Promise.resolve({ done: 1 }));
            await expect(
                runner.run('demo_failing', () => Promise.reject(new Error('smtp.internal refused'))),
            ).rejects.toThrow('smtp.internal refused');

            expectError(await t.http.get(`${t.prefix}/health/jobs`), 401, 'UNAUTHENTICATED');
            expectError(
                await t.http
                    .get(`${t.prefix}/health/jobs`)
                    .set('Authorization', await fx.bearer(await fx.client())),
                403,
                'FORBIDDEN',
            );

            const res = await t.http
                .get(`${t.prefix}/health/jobs`)
                .set('Authorization', await fx.bearer(superAdmin));
            expect(res.status).toBe(200);
            const rows = res.body.data as {
                _id: string;
                last_status?: string;
                last_error?: string;
                last_duration_ms?: number;
                consecutive_failures: number;
            }[];
            const ok = rows.find((row) => row._id === 'demo_ok');
            const failing = rows.find((row) => row._id === 'demo_failing');
            expect(ok).toMatchObject({ last_status: 'ok', consecutive_failures: 0 });
            expect(ok!.last_error).toBeUndefined();
            expect(typeof ok!.last_duration_ms).toBe('number');
            expect(failing).toMatchObject({
                last_status: 'failed',
                last_error: 'smtp.internal refused',
                consecutive_failures: 1,
            });
        });
    });

    describe('metrics', () => {
        it('exposes Prometheus metrics for requests, jobs and transactions', async () => {
            await t.http.get(`${t.prefix}/organizations`);
            const res = await scrape();
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/plain');
            expect(res.text).toContain('http_request_duration_seconds');
            expect(res.text).toContain('db_transactions_total');
            expect(res.text).toContain('job_runs_total');
            expect(res.text).toContain('sms_messages_total');
            expect(res.text).toContain('process_cpu_seconds_total');
            expect(res.text).toContain(`env="test"`);
        });

        it('counts a 4xx it served, labelled by route pattern rather than by URL', async () => {
            await t.http.get(`${t.prefix}/services/deadbeefdeadbeefdeadbeef`);
            const res = await scrape();
            expect(res.text).toContain('http_request_errors_total');
            expect(res.text).toContain(`route="${t.prefix}/services/:id"`);
            expect(res.text).not.toContain('deadbeefdeadbeefdeadbeef');
        });

        it('says in meta and in a metric how many rows the response schema refused', async () => {
            const organization = await fx.organization();
            await fx.collection('Service').collection.insertOne({
                organization_id: new Types.ObjectId(organization.id),
                category_id: null,
                position: 0,
                label: 42,
                enabled: true,
                status: 'published',
                value: {},
                options: [],
                created_at: new Date(),
                updated_at: new Date(),
            });
            await fx.service(organization.id);

            const listed = await t.http.get(`${t.prefix}/services?organization_id=${organization.id}`);
            expect(listed.status).toBe(200);
            expect(listed.body.data).toHaveLength(1);
            expect(listed.body.meta.dropped).toBe(1);
            expect(listed.body.meta.total).toBe(2);

            const res = await scrape();
            expect(res.text).toContain('response_items_dropped_total');
            expect(res.text).toContain(`route="${t.prefix}/services"`);
        });

        it('serves nothing anonymously when no token is configured, instead of the whole registry', async () => {
            config.metrics.token = undefined;
            expectError(await t.http.get(`${t.prefix}/metrics`), 401, 'UNAUTHENTICATED');
            expectError(
                await t.http.get(`${t.prefix}/metrics`).set('Authorization', 'Bearer anything'),
                401,
                'UNAUTHENTICATED',
            );
            expect((await scrape()).status).toBe(200);
        });

        it('requires the metrics token when one is configured, and a super-admin token also works', async () => {
            config.metrics.token = 'scrape-me';
            expectError(await t.http.get(`${t.prefix}/metrics`), 401, 'UNAUTHENTICATED');
            expectError(
                await t.http.get(`${t.prefix}/metrics`).set('Authorization', 'Bearer wrong'),
                401,
                'UNAUTHENTICATED',
            );
            expect(
                (await t.http.get(`${t.prefix}/metrics`).set('Authorization', 'Bearer scrape-me')).status,
            ).toBe(200);
            expect(
                (await t.http.get(`${t.prefix}/metrics`).set('Authorization', await fx.bearer(superAdmin)))
                    .status,
            ).toBe(200);
        });

        it('is not served at all when metrics are switched off, and stays out of the OpenAPI document', async () => {
            config.metrics.enabled = false;
            expectError(await t.http.get(`${t.prefix}/metrics`), 404, 'NOT_FOUND');
            const docs = await t.http.get('/api/docs-json');
            expect(docs.body.paths[`${t.prefix}/metrics`]).toBeUndefined();
        });
    });
});
