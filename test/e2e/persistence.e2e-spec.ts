import { getModelToken } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';

import { CascadeRegistry } from '../../src/common/cascade/cascade.registry';
import { TransactionRunner } from '../../src/common/database/transaction-runner';
import { OrganizationsService } from '../../src/modules/organizations/organizations.service';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

interface Migration {
    INDEXES: Record<string, { key: Record<string, unknown>; name: string; [option: string]: unknown }[]>;
    up(db: unknown): Promise<void>;
    down(db: unknown): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const timezoneMigration =
    require('../../migrations/20260922000000-organization-timezone-and-booking-start.js') as Migration;
const slotsMigration = require('../../migrations/20260922100000-slots-collection.js') as Migration;
const migrations: Migration[] = [
    require('../../migrations/20260905000000-initial-indexes.js') as Migration,
    require('../../migrations/20260911000000-bookings-collection.js') as Migration,
    require('../../migrations/20260911100000-images-name-index.js') as Migration,
    require('../../migrations/20260912000000-idempotency-keys.js') as Migration,
    require('../../migrations/20260914000000-p3-catalogue-and-lifecycle.js') as Migration,
    require('../../migrations/20260916000000-images-src-index.js') as Migration,
    timezoneMigration,
    slotsMigration,
];
/* eslint-enable @typescript-eslint/no-require-imports */

const DECLARED = migrations.reduce<Migration['INDEXES']>((all, migration) => {
    for (const [collection, indexes] of Object.entries(migration.INDEXES)) {
        const kept = (all[collection] ?? []).filter(
            (index) => !indexes.some((redefined) => redefined.name === index.name),
        );
        all[collection] = [...kept, ...indexes];
    }

    return all;
}, {});

const MODEL_BY_COLLECTION: Record<string, string> = {
    organizations: 'Organization',
    news: 'News',
    infosections: 'InfoSection',
    categories: 'Category',
    services: 'Service',
    users: 'User',
    sessions: 'Session',
    verification_codes: 'VerificationCode',
    images: 'Image',
    archives: 'Archive',
    sms: 'Sms',
    analytics_events: 'AnalyticsEvent',
    job_locks: 'JobLock',
    rate_limits: 'RateLimit',
    bookings: 'Booking',
    sms_counters: 'SmsCounter',
    idempotency_keys: 'IdempotencyKey',
    waitlist: 'WaitlistEntry',
    outbox_events: 'OutboxEvent',
    webhooks: 'Webhook',
    service_revisions: 'ServiceRevision',
    slots: 'Slot',
};

describe('persistence (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('transactions', () => {
        it('a forced mid-transaction failure leaves zero partial writes', async () => {
            const tx = t.app.get(TransactionRunner);
            const organizations = t.app.get<Model<unknown>>(getModelToken('Organization'));
            const sideEffect = jest.fn();
            await expect(
                tx.run(async (ctx) => {
                    await organizations.create([{ main_label: 'partial', main_image: 'https://x/y.jpg' }], {
                        session: ctx.session,
                    });
                    ctx.afterCommit(sideEffect);
                    throw new Error('induced failure');
                }),
            ).rejects.toThrow('induced failure');
            expect(await organizations.countDocuments({ main_label: 'partial' })).toBe(0);
            expect(sideEffect).not.toHaveBeenCalled();

            await tx.run(async (ctx) => {
                await organizations.create([{ main_label: 'committed', main_image: 'https://x/y.jpg' }], {
                    session: ctx.session,
                });
                ctx.afterCommit(sideEffect);
            });
            expect(await organizations.countDocuments({ main_label: 'committed' })).toBe(1);
            expect(sideEffect).toHaveBeenCalledTimes(1);
        });

        it('a failing cascade hook rolls back the whole organization delete', async () => {
            const organization = await fx.organization();
            await fx.news(organization.id);
            const cascade = t.app.get(CascadeRegistry);
            cascade.register('organization', 'test.failing_hook', () =>
                Promise.reject(new Error('hook failure')),
            );
            await expect(t.app.get(OrganizationsService).delete(organization.id)).rejects.toThrow(
                'hook failure',
            );
            expect(
                await fx
                    .collection('Organization')
                    .countDocuments({ _id: new Types.ObjectId(organization.id) }),
            ).toBe(1);
            expect(
                await fx
                    .collection('News')
                    .countDocuments({ organization_id: new Types.ObjectId(organization.id) }),
            ).toBe(1);
            const hooks = (cascade as unknown as { hooks: Map<string, { name: string }[]> }).hooks.get(
                'organization',
            )!;
            hooks.splice(
                hooks.findIndex((hook) => hook.name === 'test.failing_hook'),
                1,
            );
        });
    });

    describe('indexes', () => {
        it('the migration creates every index the schemas declare, and down removes them all', async () => {
            const db = t.connection.db!;
            await Promise.all(
                Object.values(t.connection.collections).map((collection) =>
                    collection.dropIndexes().catch(() => undefined),
                ),
            );

            for (const migration of migrations) await migration.up(db);

            for (const [collection, declared] of Object.entries(DECLARED)) {
                const actual = await db.collection(collection).indexes();

                for (const index of declared) {
                    const found = actual.find((item) => item.name === index.name);
                    const isText = Object.values(index.key).includes('text');

                    if (isText) {
                        expect(
                            found
                                ? Object.keys(found.weights as Record<string, number>)
                                : `${collection}.${index.name} missing`,
                        ).toEqual(Object.keys(index.key));
                    } else {
                        expect(found ? found.key : `${collection}.${index.name} missing`).toEqual(index.key);
                    }

                    if (index['unique']) expect(found?.unique).toBe(true);

                    if (index['partialFilterExpression'])
                        expect(found?.partialFilterExpression).toEqual(index['partialFilterExpression']);

                    if (index['expireAfterSeconds'] !== undefined)
                        expect(found?.expireAfterSeconds).toBe(index['expireAfterSeconds']);
                }

                const modelName = MODEL_BY_COLLECTION[collection]!;
                const model = t.app.get<Model<unknown>>(getModelToken(modelName));

                for (const [key] of model.schema.indexes()) {
                    const inMigration = declared.some(
                        (index) => JSON.stringify(index.key) === JSON.stringify(key),
                    );
                    expect(
                        inMigration
                            ? true
                            : `${collection}: schema index ${JSON.stringify(key)} not in migration`,
                    ).toBe(true);
                }
            }

            for (const migration of [...migrations].reverse()) await migration.down(db);

            for (const collection of Object.keys(DECLARED)) {
                // `bookings` is dropped whole by its own down(), so there is nothing left to inspect.
                if ((await db.listCollections({ name: collection }).toArray()).length === 0) continue;

                const remaining = (await db.collection(collection).indexes()).filter(
                    (index) => index.name !== '_id_',
                );
                expect(remaining).toEqual([]);
            }

            await Promise.all(Object.values(t.connection.models).map((model) => model.syncIndexes()));
        });

        it('unique partial indexes allow several accounts without login or phone', async () => {
            await Promise.all(Object.values(t.connection.models).map((model) => model.syncIndexes()));
            await fx.client();
            await fx.client();
            await fx.admin([]);
            await fx.admin([]);
            const users = fx.collection<{ phone?: string }>('User');
            await expect(
                users.create({
                    role: 'common-user',
                    phone: '4915290000001',
                    organization_ids: [],
                    bookings: [],
                }),
            ).resolves.toBeDefined();
            await expect(
                users.create({
                    role: 'common-user',
                    phone: '4915290000001',
                    organization_ids: [],
                    bookings: [],
                }),
            ).rejects.toMatchObject({ code: 11000 });
        });

        it('backfills the organization zone and resolves every dated booking into starts_at', async () => {
            const db = t.connection.db!;
            const migration = timezoneMigration;
            const tokyo = new Types.ObjectId();
            const berlin = new Types.ObjectId();
            await db.collection('organizations').insertMany([
                { _id: tokyo, main_label: 'Tokyo', main_image: 'x', timezone: 'Asia/Tokyo' },
                { _id: berlin, main_label: 'Berlin', main_image: 'x' },
            ]);
            await db.collection('bookings').insertMany([
                { id: 'a', organization_id: tokyo, slot_date: '2026-07-15', slot_time: '09:00' },
                { id: 'b', organization_id: berlin, slot_date: '2026-07-15', slot_time: '09:00' },
                { id: 'c', organization_id: berlin, slot_date: null, slot_time: null },
            ]);

            await migration.up(db);

            const zones = await db
                .collection<{ _id: Types.ObjectId; timezone: string }>('organizations')
                .find({})
                .toArray();
            expect(zones.find((row) => row._id.equals(tokyo))?.timezone).toBe('Asia/Tokyo');
            expect(zones.find((row) => row._id.equals(berlin))?.timezone).toBe(t.config.jobs.timezone);

            const rows = await db
                .collection<{ id: string; starts_at: Date | null }>('bookings')
                .find({})
                .toArray();
            const startsAt = (id: string): Date | null =>
                rows.find((row) => row.id === id)?.starts_at ?? null;
            expect(startsAt('a')?.toISOString()).toBe('2026-07-15T00:00:00.000Z');
            expect(startsAt('b')?.toISOString()).toBe('2026-07-15T09:00:00.000Z');
            expect(startsAt('c')).toBeNull();

            await migration.down(db);
            await Promise.all(Object.values(t.connection.models).map((model) => model.syncIndexes()));
        });

        it('moves embedded slots into their own collection in order, and down puts them back', async () => {
            const db = t.connection.db!;
            const organizationId = new Types.ObjectId();
            const serviceId = new Types.ObjectId();
            const dated = (id: string, date: string) => ({
                id,
                label: id,
                child_type: 'date',
                value: { date, limit: 2, booked_count: 1 },
            });
            const timed = {
                id: 'c',
                label: 'c',
                child_type: 'date_time',
                value: { date: '2026-10-03', time: [{ time: '09:00', limit: 1, booked_count: 0 }] },
            };
            // The old embedded schema wrote `time: []` onto every slot.
            const legacy = {
                ...dated('a', '2026-10-01'),
                value: { ...dated('a', '2026-10-01').value, time: [] },
            };
            const options = [
                {
                    id: 'o1',
                    label: 'one',
                    service_type: 'service_apply',
                    enabled: true,
                    slots: [dated('b', '2026-10-02'), legacy],
                },
                { id: 'o2', label: 'two', service_type: 'service_apply', enabled: true, slots: [timed] },
            ];
            await db
                .collection('slots')
                .drop()
                .catch(() => undefined);
            await db
                .collection('services')
                .insertOne({ _id: serviceId, organization_id: organizationId, label: 's', options });
            // An interrupted earlier run that had copied only the first slot.
            await db.collection('slots').insertOne({
                service_id: serviceId,
                organization_id: organizationId,
                option_id: 'o1',
                ...dated('b', '2026-10-02'),
            });

            await slotsMigration.up(db);
            await slotsMigration.up(db);

            const moved = await db.collection('slots').find({}).sort({ _id: 1 }).toArray();
            expect(moved.map((row) => [row['option_id'], row['id']])).toEqual([
                ['o1', 'b'],
                ['o1', 'a'],
                ['o2', 'c'],
            ]);
            expect(moved[1]).toMatchObject({ service_id: serviceId, organization_id: organizationId });
            expect(moved[1]!['value']).toEqual({ date: '2026-10-01', limit: 2, booked_count: 1 });
            expect(moved[2]!['value']).toEqual(timed.value);
            const stripped = await db.collection('services').findOne({ _id: serviceId });
            expect(stripped!['options']).toEqual(options.map(({ slots: _slots, ...option }) => option));

            await slotsMigration.down(db);

            expect((await db.collection('services').findOne({ _id: serviceId }))!['options']).toEqual([
                { ...options[0], slots: [dated('b', '2026-10-02'), dated('a', '2026-10-01')] },
                options[1],
            ]);
            expect(await db.listCollections({ name: 'slots' }).toArray()).toEqual([]);
            await Promise.all(Object.values(t.connection.models).map((model) => model.syncIndexes()));
        });
    });
});
