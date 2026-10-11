import { SchedulerRegistry } from '@nestjs/schedule';

import { AppConfig } from '../../src/common/config/app-config';
import { AUTO_NO_SHOW_JOB, AutoNoShowJob } from '../../src/jobs/auto-no-show.job';
import { BOOKING_REMINDERS_JOB, BookingRemindersJob } from '../../src/jobs/booking-reminders.job';
import { CASCADE_RECONCILE_JOB, CascadeReconcileJob } from '../../src/jobs/cascade-reconcile.job';
import { DEBTOR_REPORT_JOB, DebtorReportJob } from '../../src/jobs/debtor-report.job';
import { JobRunner } from '../../src/jobs/job-runner';
import { JobsScheduler } from '../../src/jobs/jobs.scheduler';
import { NEWS_EXPIRY_JOB, NewsExpiryJob } from '../../src/jobs/news-expiry.job';
import { OUTBOX_DISPATCH_JOB, OutboxDispatchJob } from '../../src/jobs/outbox-dispatch.job';
import { RECURRENT_SLOTS_JOB, RecurrentSlotsJob } from '../../src/jobs/recurrent-slots.job';
import { SLOT_EXPIRY_JOB, SlotExpiryJob } from '../../src/jobs/slot-expiry.job';
import { STALE_BOOKINGS_JOB, StaleBookingsJob } from '../../src/jobs/stale-bookings.job';
import { STORAGE_GC_JOB, StorageGcJob } from '../../src/jobs/storage-gc.job';
import { TRASH_PURGE_JOB, TrashPurgeJob } from '../../src/jobs/trash-purge.job';
import { UNREFERENCED_IMAGES_JOB, UnreferencedImagesJob } from '../../src/jobs/unreferenced-images.job';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

interface LockRow {
    _id: string;
    last_status?: string;
    last_error?: string;
    consecutive_failures?: number;
    last_success_at?: Date;
}

describe('job runs (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    const lock = (job: string) => fx.collection<LockRow>('JobLock').findById(job).lean<LockRow>();

    it('runs every job under its lease on an empty database and records the success', async () => {
        const jobs: [string, { run(): Promise<unknown> }][] = [
            [RECURRENT_SLOTS_JOB, t.app.get(RecurrentSlotsJob)],
            [NEWS_EXPIRY_JOB, t.app.get(NewsExpiryJob)],
            [SLOT_EXPIRY_JOB, t.app.get(SlotExpiryJob)],
            [STALE_BOOKINGS_JOB, t.app.get(StaleBookingsJob)],
            [CASCADE_RECONCILE_JOB, t.app.get(CascadeReconcileJob)],
            [STORAGE_GC_JOB, t.app.get(StorageGcJob)],
            [DEBTOR_REPORT_JOB, t.app.get(DebtorReportJob)],
            [UNREFERENCED_IMAGES_JOB, t.app.get(UnreferencedImagesJob)],
            [BOOKING_REMINDERS_JOB, t.app.get(BookingRemindersJob)],
            [AUTO_NO_SHOW_JOB, t.app.get(AutoNoShowJob)],
            [OUTBOX_DISPATCH_JOB, t.app.get(OutboxDispatchJob)],
            [TRASH_PURGE_JOB, t.app.get(TrashPurgeJob)],
        ];

        for (const [name, job] of jobs) {
            const outcome = (await job.run()) as { ran: boolean };

            expect(outcome.ran).toBe(true);
            expect(await lock(name)).toMatchObject({ last_status: 'ok', consecutive_failures: 0 });
        }
    });

    it('records a failure with its message, counts repeats and clears them on the next success', async () => {
        const runner = t.app.get(JobRunner);
        const fail = () => runner.run('flaky', () => Promise.reject(new Error('x'.repeat(800))));

        await expect(fail()).rejects.toThrow();
        await expect(fail()).rejects.toThrow();
        const failed = await lock('flaky');
        expect(failed).toMatchObject({ last_status: 'failed', consecutive_failures: 2 });
        expect(failed!.last_error).toHaveLength(500);

        await expect(runner.run('flaky', jest.fn().mockRejectedValue('plain string'))).rejects.toBe(
            'plain string',
        );
        expect((await lock('flaky'))!.last_error).toBe('plain string');

        const ok = await runner.run('flaky', () => Promise.resolve({ done: 1 }));
        expect(ok).toMatchObject({ ran: true, result: { done: 1 } });
        const recovered = await lock('flaky');
        expect(recovered).toMatchObject({ last_status: 'ok', consecutive_failures: 0 });
        expect(recovered!.last_error).toBeUndefined();
        expect(recovered!.last_success_at).toBeInstanceOf(Date);
    });

    it('shows an unscheduled job in the health report next to the scheduled ones', async () => {
        await t.app.get(JobRunner).run('ad_hoc', () => Promise.resolve());

        const res = await t.http
            .get(`${t.prefix}/health/jobs`)
            .set('Authorization', await fx.bearer(await fx.superAdmin()));
        expect(res.status).toBe(200);
        const rows = res.body.data as { _id: string; scheduled: boolean; cron: string | null }[];
        expect(rows.find((row) => row._id === 'ad_hoc')).toMatchObject({ scheduled: false, cron: null });
        expect(rows.find((row) => row._id === NEWS_EXPIRY_JOB)).toMatchObject({ cron: expect.any(String) });
        expect(rows.map((row) => row._id)).toEqual([...rows.map((row) => row._id)].sort());
    });

    it('registers every cron job when enabled and removes them again on shutdown', () => {
        const config = t.app.get(AppConfig);
        const scheduler = t.app.get(JobsScheduler);
        const registry = t.app.get(SchedulerRegistry);
        const before = registry.getCronJobs().size;

        config.jobs.enabled = true;
        try {
            scheduler.onModuleInit();
            expect(registry.getCronJobs().size).toBe(before + 12);
            expect(registry.getCronJob(OUTBOX_DISPATCH_JOB)).toBeDefined();
        } finally {
            scheduler.onModuleDestroy();
            config.jobs.enabled = false;
        }

        expect(registry.getCronJobs().size).toBe(before);
        expect(() => scheduler.onModuleDestroy()).not.toThrow();
    });
});
