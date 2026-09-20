import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { AppConfig } from '../../src/common/config/app-config';
import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../../src/integrations/storage/storage.provider';
import { CascadeReconcileJob } from '../../src/jobs/cascade-reconcile.job';
import { DebtorReportJob } from '../../src/jobs/debtor-report.job';
import { JobLockService } from '../../src/jobs/job-lock.service';
import { JobRunner } from '../../src/jobs/job-runner';
import { NewsExpiryJob } from '../../src/jobs/news-expiry.job';
import { RecurrentSlotsJob } from '../../src/jobs/recurrent-slots.job';
import { SlotExpiryJob } from '../../src/jobs/slot-expiry.job';
import { StaleBookingsJob } from '../../src/jobs/stale-bookings.job';
import { StorageGcJob } from '../../src/jobs/storage-gc.job';
import { UnreferencedImagesJob } from '../../src/jobs/unreferenced-images.job';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('jobs (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('job_locks', () => {
        it('two workers with one due job → exactly one execution; an expired lease is re-acquirable', async () => {
            const locks = t.app.get(JobLockService);
            const runner = t.app.get(JobRunner);
            let executions = 0;
            const work = async (): Promise<void> => {
                executions += 1;
                await new Promise((resolve) => setTimeout(resolve, 200));
            };
            const outcomes = await Promise.all([runner.run('demo', work), runner.run('demo', work)]);
            expect(executions).toBe(1);
            expect(outcomes.map((outcome) => outcome.ran).sort()).toEqual([false, true]);

            const lease = await locks.acquire('demo');
            expect(lease).not.toBeNull();
            await fx
                .collection('JobLock')
                .updateOne(
                    { _id: 'demo' },
                    { $set: { locked_until: new Date(Date.now() - 1000), holder: 'dead' } },
                );
            const reacquired = await locks.acquire('demo');
            expect(reacquired?.holder).toBe(locks.holderId);
            await fx
                .collection('JobLock')
                .updateOne(
                    { _id: 'demo' },
                    { $set: { locked_until: new Date(Date.now() + 60_000), holder: 'other' } },
                );
            expect(await locks.acquire('demo')).toBeNull();
        });
    });

    describe('recurrent slots', () => {
        it('generates date_time slots over the horizon, idempotently, in one bulk write', async () => {
            const organization = await fx.organization();
            const service = await fx.service(organization.id, {
                options: [
                    {
                        id: '11111111-1111-4111-8111-111111111111',
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        recurrent_dates: [
                            { day: 'monday', time: [{ time: '09:00', limit: 2 }] },
                            { day: 'friday', time: [{ time: '15:00', limit: null }] },
                        ],
                        slots: [],
                    },
                ],
            });
            const job = t.app.get(RecurrentSlotsJob);
            const now = new Date(2026, 8, 5);
            expect(await job.execute(now)).toEqual({ services_updated: 1 });
            const stored = await fx
                .collection<{
                    options: {
                        slots: {
                            child_type: string;
                            value: { date: string; time: { time: string; limit: number | null }[] };
                        }[];
                    }[];
                }>('Service')
                .findById(service.id)
                .lean();
            const slots = stored!.options[0]!.slots;
            expect(slots).toHaveLength(9);
            expect(slots.every((slot) => slot.child_type === 'date_time')).toBe(true);
            expect(slots[0]!.value).toMatchObject({
                date: '2026-09-07',
                time: [{ time: '09:00', limit: 2 }],
            });
            expect(await job.execute(now)).toEqual({ services_updated: 0 });
        });

        it('updates slots in place: existing bookings and their times survive', async () => {
            const organization = await fx.organization();
            const client = await fx.client();
            const optionId = '11111111-1111-4111-8111-111111111111';
            const slotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            const service = await fx.service(organization.id, {
                options: [
                    {
                        id: optionId,
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        recurrent_dates: [{ day: 'monday', time: [{ time: '09:00', limit: 2 }] }],
                        slots: [
                            {
                                id: slotId,
                                label: 'd',
                                child_type: 'date_time',
                                value: {
                                    date: '2026-09-07',
                                    time: [
                                        { time: '18:00', limit: null, booked_count: 0 },
                                        { time: '20:00', limit: null, booked_count: 0 },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            });

            await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: optionId,
                slot_id: slotId,
                user_id: client.id,
                time: '18:00',
                person: 'Anna',
                phone: '375291112233',
            });

            expect(await t.app.get(RecurrentSlotsJob).execute(new Date(2026, 8, 5))).toEqual({
                services_updated: 1,
            });
            const stored = await fx
                .collection<{
                    options: {
                        slots: {
                            id: string;
                            value: { date: string; time: { time: string; booked_count: number }[] };
                        }[];
                    }[];
                }>('Service')
                .findById(service.id)
                .lean();
            const slot = stored!.options[0]!.slots.find((item) => item.id === slotId)!;
            const times = slot.value.time.map((entry) => entry.time);
            expect(times).toContain('09:00');
            expect(times).toContain('18:00');
            expect(times).not.toContain('20:00');
            expect(slot.value.time.find((entry) => entry.time === '18:00')).toMatchObject({
                booked_count: 1,
            });
        });
    });

    describe('expiry jobs', () => {
        it('archives expired news transactionally', async () => {
            const organization = await fx.organization();
            const expired = await fx.news(organization.id, { expires_at: new Date('2020-01-01T00:00:00Z') });
            await fx.news(organization.id, { expires_at: new Date('2999-01-01T00:00:00Z') });
            await fx.news(organization.id);
            expect(await t.app.get(NewsExpiryJob).execute(new Date())).toEqual({ archived: 1 });
            expect(await fx.collection('News').countDocuments({})).toBe(2);
            const archives = await fx
                .collection<{ type: string; data: { _id: string } }>('Archive')
                .find({})
                .lean();
            expect(archives).toHaveLength(1);
            expect(archives[0]!.type).toBe('news');
            expect(archives[0]!.data._id).toBe(expired.id);
        });

        it('archives expired dated slots with their bookings and deletes both', async () => {
            const organization = await fx.organization();
            const client = await fx.client();
            const service = await fx.service(organization.id, {
                options: [
                    {
                        id: '11111111-1111-4111-8111-111111111111',
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        slots: [
                            {
                                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                label: 'old',
                                child_type: 'date',
                                value: { date: '2020-01-01', limit: null, booked_count: 0 },
                            },
                            {
                                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                                label: 'future',
                                child_type: 'date',
                                value: { date: '2999-01-01', limit: null, booked_count: 0 },
                            },
                            {
                                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                                label: 'apply',
                                child_type: 'apply',
                                value: { limit: null, booked_count: 0 },
                            },
                        ],
                    },
                ],
            });
            await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: '11111111-1111-4111-8111-111111111111',
                slot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                user_id: client.id,
                child_type: 'date',
            });
            expect(await t.app.get(SlotExpiryJob).execute(new Date())).toEqual({
                services_updated: 1,
                slots_archived: 1,
            });
            const stored = await fx
                .collection<{ options: { slots: { id: string }[] }[] }>('Service')
                .findById(service.id)
                .lean();
            expect(stored!.options[0]!.slots.map((slot) => slot.id)).toEqual([
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            ]);
            const archive = await fx
                .collection<{ data: { bookings: unknown[] } }>('Archive')
                .findOne({ type: 'service', service_id: new Types.ObjectId(service.id) })
                .lean();
            expect(archive!.data.bookings).toHaveLength(1);
            expect(await fx.collection('Booking').countDocuments({})).toBe(0);
        });

        it('stale booking cleanup drops bookings whose slot no longer exists, and keeps live ones', async () => {
            const organization = await fx.organization();
            const client = await fx.client();
            const option = fx.bookableOption(2);
            const service = await fx.service(organization.id, { options: [option] });
            const live = await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
            });
            await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: 'removed-by-hand',
                user_id: client.id,
                child_type: 'apply',
            });

            expect(await t.app.get(StaleBookingsJob).execute()).toEqual({ bookings_removed: 1 });
            expect(await t.app.get(StaleBookingsJob).execute()).toEqual({ bookings_removed: 0 });
            const remaining = await fx.collection<{ id: string }>('Booking').find({}).lean();
            expect(remaining.map((row) => row.id)).toEqual([live.id]);
        });
    });

    describe('storage gc', () => {
        const ancient = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        it('removes a stored file no image row points at, and nothing else', async () => {
            const storage = t.app.get<StorageProvider>(STORAGE_PROVIDER);
            const root = t.app.get(AppConfig).storage.local.dir;
            const organization = await fx.organization();
            const kept = `${organization.id}/${randomUUID()}.jpg`;
            const orphan = `${organization.id}/${randomUUID()}.jpg`;
            // Not a key this application ever writes: a bucket it shares stays out of reach.
            const foreign = `backups/${randomUUID()}.zip`;

            await storage.put(kept, Buffer.from('kept'), 'image/jpeg');
            await storage.put(orphan, Buffer.from('orphaned'), 'image/jpeg');
            await storage.put(foreign, Buffer.from('foreign'), 'application/zip');
            await fx.image(organization.id, { name: kept });

            const job = t.app.get(StorageGcJob);
            const exists = async (key: string) => {
                for await (const object of storage.list()) {
                    if (object.key === key) return true;
                }

                return false;
            };

            // Fresh files are never candidates: the window covers an upload between `put` and its row.
            await job.execute(new Date());
            expect(await exists(orphan)).toBe(true);

            for (const key of [kept, orphan, foreign]) await utimes(join(root, key), ancient, ancient);

            const summary = await job.execute(new Date());
            expect(summary.orphans).toBeGreaterThanOrEqual(1);
            expect(await exists(orphan)).toBe(false);
            expect(await exists(kept)).toBe(true);
            expect(await exists(foreign)).toBe(true);

            await storage.delete(kept);
            await storage.delete(foreign);
        });
    });

    describe('cascade reconcile', () => {
        it('cleans up after an organization deleted around the cascade, and leaves the rest alone', async () => {
            const organization = await fx.organization();
            const survivor = await fx.organization();
            const admin = await fx.admin([organization.id, survivor.id]);
            const client = await fx.client();
            const option = fx.bookableOption(2);
            const service = await fx.service(organization.id, { options: [option] });
            await fx.booking({
                service_id: service.id,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
            });
            await fx.news(organization.id);
            await fx.category(organization.id);
            await fx.infoSection(organization.id);
            await fx.image(organization.id);
            await fx.service(survivor.id, { options: [] });
            await fx.news(survivor.id);

            const job = t.app.get(CascadeReconcileJob);
            expect(await job.execute()).toEqual({
                dangling_organizations: 0,
                reconciled: {},
                left_behind: {},
                refused: false,
            });

            // What a migration or a shell session leaves behind: the parent gone, the children not.
            await fx.collection('Organization').deleteOne({ _id: new Types.ObjectId(organization.id) });

            const result = await job.execute();
            expect(result.dangling_organizations).toBe(1);
            expect(result.reconciled).toMatchObject({
                services: 1,
                bookings: 1,
                news: 1,
                categories: 1,
                infosections: 1,
                images: 1,
                users: 1,
            });
            expect(result.left_behind).toEqual({});
            expect(result.refused).toBe(false);

            const stored = await fx
                .collection<{ organization_ids: Types.ObjectId[] }>('User')
                .findById(admin.id)
                .lean();
            expect(stored!.organization_ids.map((id) => id.toHexString())).toEqual([survivor.id]);
            expect(await fx.collection('Service').countDocuments({})).toBe(1);
            expect(await fx.collection('News').countDocuments({})).toBe(1);
            expect(await fx.collection('Booking').countDocuments({})).toBe(0);

            // Idempotent: a second pass has nothing left to find.
            expect(await job.execute()).toEqual({
                dangling_organizations: 0,
                reconciled: {},
                left_behind: {},
                refused: false,
            });
        });
    });

    describe('unreferenced images', () => {
        it('reports only the images nothing refers to, and deletes nothing', async () => {
            const organization = await fx.organization();
            const inNews = await fx.image(organization.id);
            const inService = await fx.image(organization.id);
            const unused = await fx.image(organization.id);
            const logo = await fx.image(organization.id);
            await fx
                .collection('Organization')
                .updateOne({ _id: new Types.ObjectId(organization.id) }, { $set: { main_image: logo.src } });
            await fx.news(organization.id, { value: { image_value: inNews.src } });
            await fx.service(organization.id, { value: { image_value: inService.src }, options: [] });

            const job = t.app.get(UnreferencedImagesJob);
            const rows = await job.collect();
            expect(rows.map((row) => row.src)).toEqual([unused.src]);
            expect(rows[0]).toMatchObject({ organization: organization.main_label, size: 1024 });

            const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
            expect(await job.execute()).toEqual({ rows: 1, bytes: 1024, recipients: 1 });
            const message = mail.mock.calls[0]![0] as {
                to: string[];
                attachments: { filename: string; content: Buffer }[];
            };
            expect(message.to).toEqual(['reports@example.com']);
            expect(message.attachments[0]!.filename).toMatch(/\.xlsx$/);
            expect(await fx.collection('Image').countDocuments({})).toBe(4);
            mail.mockRestore();
        });
    });

    describe('debtor report', () => {
        it('lists apply options without upcoming slots and mails an xlsx attachment', async () => {
            const organization = await fx.organization({ main_label: 'Clinic', main_category: 'healthcare' });
            const ignored = await fx.organization({ main_label: 'No category', main_category: undefined });
            const base = { id: 'o', label: 'x', service_type: 'service_apply' as const, enabled: true };
            await fx.service(organization.id, {
                value: { heading_value: 'Empty option' },
                options: [{ ...base, slots: [] }],
            });
            await fx.service(organization.id, {
                value: { heading_value: 'Only past' },
                options: [
                    {
                        ...base,
                        slots: [
                            {
                                id: 's',
                                label: 'd',
                                child_type: 'date',
                                value: { date: '2000-01-01', limit: null, booked_count: 0 },
                            },
                        ],
                    },
                ],
            });
            await fx.service(organization.id, {
                value: { heading_value: 'Has future' },
                options: [
                    {
                        ...base,
                        slots: [
                            {
                                id: 's',
                                label: 'd',
                                child_type: 'date',
                                value: { date: '2999-01-01', limit: null, booked_count: 0 },
                            },
                        ],
                    },
                ],
            });
            await fx.service(organization.id, {
                value: { heading_value: 'Recurrent' },
                options: [{ ...base, recurrent_dates: [{ day: 'monday', time: [] }], slots: [] }],
            });
            await fx.service(ignored.id, {
                value: { heading_value: 'Ignored' },
                options: [{ ...base, slots: [] }],
            });

            const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
            const job = t.app.get(DebtorReportJob);
            const rows = await job.collect(new Date());
            expect(rows.map((row) => row.service).sort()).toEqual(['Empty option', 'Only past']);
            expect(await job.execute(new Date())).toEqual({ rows: 2, recipients: 1 });
            const message = mail.mock.calls[0]![0] as {
                to: string[];
                attachments: { filename: string; content: Buffer }[];
            };
            expect(message.to).toEqual(['reports@example.com']);
            expect(message.attachments[0]!.filename).toMatch(/\.xlsx$/);
            expect(message.attachments[0]!.content.length).toBeGreaterThan(1000);
            mail.mockRestore();
        });
    });
});
