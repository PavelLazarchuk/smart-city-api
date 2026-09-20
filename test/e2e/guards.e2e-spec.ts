import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type Types } from 'mongoose';

import { maskedServiceResponseSchema } from '../../src/modules/services/dto/service.schemas';
import { ServicesRepository } from '../../src/modules/services/services.repository';
import { collectKeys, expectNoSensitiveKeys } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const ALLOWED_EXCEPTIONS = new Set(['_id']);

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);

        if (statSync(path).isDirectory()) walk(path, out);
        else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) out.push(path);
    }

    return out;
}

function zodKeys(schema: unknown, seen = new Set<unknown>(), out = new Set<string>()): Set<string> {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return out;

    seen.add(schema);
    const def = (schema as { def?: Record<string, unknown> }).def ?? {};

    if (schema instanceof z.ZodObject) {
        for (const [key, value] of Object.entries(schema.shape)) {
            out.add(key);
            zodKeys(value, seen, out);
        }
    }

    for (const field of [
        'innerType',
        'element',
        'in',
        'out',
        'left',
        'right',
        'type',
        'schema',
        'valueType',
    ]) {
        if (def[field] && typeof def[field] === 'object') zodKeys(def[field], seen, out);
    }

    if (Array.isArray(def['options'])) for (const option of def['options']) zodKeys(option, seen, out);

    return out;
}

describe('cross-cutting guards (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('naming', () => {
        it('every zod schema key is snake_case', () => {
            const files = walk(join(process.cwd(), 'src')).filter((file) =>
                /\/dto\/|pagination\.schema|primitives\.ts/.test(file),
            );
            expect(files.length).toBeGreaterThan(5);
            const offenders: string[] = [];

            for (const file of files) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const exported: Record<string, unknown> = require(file);

                for (const [name, value] of Object.entries(exported)) {
                    const schema = (value as { schema?: unknown })?.schema ?? value;

                    for (const key of zodKeys(schema)) {
                        if (!SNAKE.test(key) && !ALLOWED_EXCEPTIONS.has(key))
                            offenders.push(`${file}:${name}.${key}`);
                    }
                }
            }

            expect(offenders).toEqual([]);
        });

        it('every Mongoose schema path is snake_case', () => {
            const offenders: string[] = [];
            const visit = (
                schema: {
                    eachPath(
                        fn: (path: string, type: { schema?: unknown; caster?: { schema?: unknown } }) => void,
                    ): void;
                },
                prefix: string,
            ): void => {
                schema.eachPath((path, type) => {
                    for (const segment of path.split('.')) {
                        if (!SNAKE.test(segment) && !ALLOWED_EXCEPTIONS.has(segment))
                            offenders.push(`${prefix}${path}`);
                    }

                    const nested = (type.schema ?? type.caster?.schema) as typeof schema | undefined;

                    if (nested) visit(nested, `${prefix}${path}.`);
                });
            };

            for (const model of Object.values(t.connection.models))
                visit(model.schema as never, `${model.modelName}.`);

            expect(offenders).toEqual([]);
        });
    });

    describe('sensitive data', () => {
        let organization: { id: string };
        let client: FixtureUser;
        let stranger: FixtureUser;
        let admin: FixtureUser;
        let serviceId: string;

        beforeEach(async () => {
            organization = await fx.organization();
            client = await fx.client({ phone: '375291234567', name: 'Private Client' });
            stranger = await fx.client({ phone: '375297654321' });
            admin = await fx.admin([organization.id]);
            const option = fx.bookableOption(3);
            serviceId = (
                await fx.service(organization.id, {
                    options: [option],
                    value: { subscribe: 'internal@example.com' },
                })
            ).id;
            await fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
                person: 'Private Client',
                phone: '375291234567',
                info: 'allergy',
            });
            await fx.news(organization.id);
            await fx.infoSection(organization.id);
        });

        const publicRoutes = (): string[] => [
            `/organizations`,
            `/organizations?include=services,news,categories,infosections,images`,
            `/organizations/${organization.id}`,
            `/organizations/${organization.id}/services`,
            `/services`,
            `/services/${serviceId}`,
            `/categories`,
            `/news`,
            `/infosections`,
        ];

        it('no anonymous or foreign response body contains a password, code hash, subscribe address or another user’s phone', async () => {
            for (const route of publicRoutes()) {
                const anonymous = await t.http.get(`${t.prefix}${route}`);
                expect(anonymous.status).toBe(200);
                expectNoSensitiveKeys(anonymous.body);
                const text = JSON.stringify(anonymous.body);
                expect(text).not.toContain('375291234567');
                expect(text).not.toContain('Private Client');
                expect(text).not.toContain('internal@example.com');
                expect(collectKeys(anonymous.body).has('subscribe')).toBe(false);

                const asStranger = await t.http
                    .get(`${t.prefix}${route}`)
                    .set('Authorization', await fx.bearer(stranger));
                expect(JSON.stringify(asStranger.body)).not.toContain('375291234567');
            }
        });

        it('never reads the subscribe address for a public viewer, and refuses to serialize a booking', async () => {
            const repository = t.app.get(ServicesRepository);
            const listed = jest.spyOn(repository, 'paginate');
            const read = jest.spyOn(repository, 'findById');

            await t.http.get(`${t.prefix}/services`);
            await t.http.get(`${t.prefix}/services/${serviceId}`);
            await t.http.get(`${t.prefix}/services`).set('Authorization', await fx.bearer(client));

            expect(listed.mock.calls.map((call) => call[2])).toEqual([
                { 'value.subscribe': 0 },
                { 'value.subscribe': 0 },
            ]);
            expect(read.mock.calls.map((call) => call[2])).toEqual([{ 'value.subscribe': 0 }]);

            listed.mockClear();
            read.mockClear();
            await t.http.get(`${t.prefix}/services`).set('Authorization', await fx.bearer(admin));
            await t.http
                .get(`${t.prefix}/services/${serviceId}`)
                .set('Authorization', await fx.bearer(admin));
            expect(listed.mock.calls.map((call) => call[2])).toEqual([undefined]);
            expect(read.mock.calls.map((call) => call[2])).toEqual([undefined]);
            listed.mockRestore();
            read.mockRestore();

            const withBooking = (await t.http.get(`${t.prefix}/services/${serviceId}`)).body.data;
            withBooking.options[0].slots[0].value.time[0].bookings = [
                { id: 'x', user_id: client.id, person: 'Private Client', phone: '375291234567', info: '' },
            ];
            expect(maskedServiceResponseSchema.safeParse(withBooking).success).toBe(false);
        });

        it('the organization admin sees booking details; a super-admin listing users sees no hashes', async () => {
            const own = await t.http
                .get(`${t.prefix}/services/${serviceId}`)
                .set('Authorization', await fx.bearer(admin));
            expect(JSON.stringify(own.body)).toContain('375291234567');
            expectNoSensitiveKeys(own.body);
            const users = await t.http
                .get(`${t.prefix}/users`)
                .set('Authorization', await fx.bearer(await fx.superAdmin()));
            expectNoSensitiveKeys(users.body);
        });

        it('error responses never leak internal messages', async () => {
            const res = await t.http.get(`${t.prefix}/organizations/not-an-object-id`);
            expect(res.status).toBe(404);
            expect(res.body.error).toEqual({
                code: 'ORGANIZATION_NOT_FOUND',
                message: 'Organization not found.',
                request_id: expect.any(String),
            });
            const echo = await t.http
                .get(`${t.prefix}/organizations`)
                .set('X-Request-Id', 'client-request-0001');
            expect(echo.headers['x-request-id']).toBe('client-request-0001');
        });
    });

    describe('authorization matrix', () => {
        it('each role × representative endpoint', async () => {
            const organization = await fx.organization();
            const foreignOrganization = await fx.organization();
            const superAdmin = await fx.bearer(await fx.superAdmin());
            const admin = await fx.bearer(await fx.admin([organization.id]));
            const foreignAdmin = await fx.bearer(await fx.admin([foreignOrganization.id]));
            const client = await fx.bearer(await fx.client());
            const category = await fx.category(organization.id);

            const matrix: {
                method: 'get' | 'post' | 'patch' | 'delete';
                path: string;
                body?: object;
                expected: Record<string, number>;
            }[] = [
                {
                    method: 'get',
                    path: '/users',
                    expected: { anonymous: 401, client: 403, admin: 403, foreign: 403, super: 200 },
                },
                {
                    method: 'post',
                    path: '/organizations',
                    body: { main_label: 'x', main_image: 'https://e.com/i.jpg' },
                    expected: { anonymous: 401, client: 403, admin: 403, foreign: 403, super: 201 },
                },
                {
                    method: 'patch',
                    path: `/organizations/${organization.id}`,
                    body: { main_label: 'y' },
                    expected: { anonymous: 401, client: 403, admin: 200, foreign: 404, super: 200 },
                },
                {
                    method: 'post',
                    path: '/categories',
                    body: { organization_id: organization.id, label: 'c' },
                    expected: { anonymous: 401, client: 403, admin: 201, foreign: 403, super: 201 },
                },
                {
                    method: 'patch',
                    path: `/categories/${category.id}`,
                    body: { label: 'z' },
                    expected: { anonymous: 401, client: 403, admin: 200, foreign: 404, super: 200 },
                },
                {
                    method: 'get',
                    path: '/archives',
                    expected: { anonymous: 401, client: 403, admin: 200, foreign: 200, super: 200 },
                },
                {
                    method: 'get',
                    path: '/images',
                    expected: { anonymous: 401, client: 403, admin: 403, foreign: 403, super: 200 },
                },
                {
                    method: 'get',
                    path: '/sms',
                    expected: { anonymous: 401, client: 403, admin: 403, foreign: 403, super: 200 },
                },
                {
                    method: 'get',
                    path: '/analytics/events',
                    expected: { anonymous: 401, client: 403, admin: 403, foreign: 403, super: 200 },
                },
                {
                    method: 'get',
                    path: `/organizations/${organization.id}`,
                    expected: { anonymous: 200, client: 200, admin: 200, foreign: 200, super: 200 },
                },
                {
                    method: 'delete',
                    path: `/organizations/${organization.id}`,
                    expected: { anonymous: 401, client: 403, admin: 403, foreign: 403, super: 204 },
                },
            ];
            const bearers: Record<string, string | undefined> = {
                anonymous: undefined,
                client,
                admin,
                foreign: foreignAdmin,
                super: superAdmin,
            };
            const failures: string[] = [];

            for (const entry of matrix) {
                for (const [role, expected] of Object.entries(entry.expected)) {
                    let req = t.http[entry.method](`${t.prefix}${entry.path}`);
                    const bearer = bearers[role];

                    if (bearer) req = req.set('Authorization', bearer);

                    const res = await (entry.body ? req.send(entry.body) : req);

                    if (res.status !== expected)
                        failures.push(
                            `${role} ${entry.method.toUpperCase()} ${entry.path}: expected ${expected}, got ${res.status}`,
                        );
                }
            }

            expect(failures).toEqual([]);
        });
    });

    describe('performance smoke', () => {
        it('lists 500 organizations × 20 services within budget and with bounded query count', async () => {
            const organizations = fx.collection<{ _id: Types.ObjectId }>('Organization');
            const services = fx.collection('Service');
            const created = await organizations.insertMany(
                Array.from({ length: 500 }, (_, i) => ({
                    main_label: `Org ${i}`,
                    main_category: i % 2 ? 'a' : 'b',
                    main_image: 'https://e.com/i.jpg',
                })),
            );
            const docs: Record<string, unknown>[] = [];

            for (const organization of created) {
                for (let j = 0; j < 20; j += 1) {
                    docs.push({
                        organization_id: organization._id,
                        category_id: null,
                        position: j,
                        label: `S${j}`,
                        enabled: true,
                        value: {},
                        options: [],
                    });
                }
            }

            await services.insertMany(docs);

            const commands: string[] = [];
            const client = t.connection.getClient();
            const listener = (event: { commandName: string }): void => {
                commands.push(event.commandName);
            };
            client.on('commandStarted', listener);
            const started = Date.now();
            const res = await t.http.get(`${t.prefix}/organizations`);
            const elapsed = Date.now() - started;
            client.removeListener('commandStarted', listener);

            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(30);
            expect(res.body.meta.total).toBe(500);
            expect(res.body.data[0].counts.services).toBe(20);
            const dbCommands = commands.filter((name) => !['ping', 'endSessions', 'insert'].includes(name));
            expect(dbCommands.length).toBeLessThanOrEqual(4);
            expect(elapsed).toBeLessThan(1500);

            console.info(
                `organization list: ${elapsed} ms, ${dbCommands.length} db commands (${dbCommands.join(', ')})`,
            );
        }, 120_000);
    });
});
