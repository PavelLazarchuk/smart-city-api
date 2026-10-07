import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../common/config/app-config';
import { AUTO_NO_SHOW_JOB, AutoNoShowJob } from './auto-no-show.job';
import { BOOKING_REMINDERS_JOB, BookingRemindersJob } from './booking-reminders.job';
import { CASCADE_RECONCILE_JOB, CascadeReconcileJob } from './cascade-reconcile.job';
import { DEBTOR_REPORT_JOB, DebtorReportJob } from './debtor-report.job';
import { NEWS_EXPIRY_JOB, NewsExpiryJob } from './news-expiry.job';
import { OUTBOX_DISPATCH_JOB, OutboxDispatchJob } from './outbox-dispatch.job';
import { RECURRENT_SLOTS_JOB, RecurrentSlotsJob } from './recurrent-slots.job';
import { SLOT_EXPIRY_JOB, SlotExpiryJob } from './slot-expiry.job';
import { STALE_BOOKINGS_JOB, StaleBookingsJob } from './stale-bookings.job';
import { STORAGE_GC_JOB, StorageGcJob } from './storage-gc.job';
import { TRASH_PURGE_JOB, TrashPurgeJob } from './trash-purge.job';
import { UNREFERENCED_IMAGES_JOB, UnreferencedImagesJob } from './unreferenced-images.job';

export interface JobSchedule {
    name: string;
    cron: string;
    next_run_at: Date;
}

function nextRunAt(cron: string, timeZone: string, now: Date): Date {
    return new CronTime(cron, timeZone).getNextDateFrom(now, timeZone).toJSDate();
}

/** `JOBS_ENABLED` only decides whether this process schedules; mutual exclusion is the `job_locks` lease. */
@Injectable()
export class JobsScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly registered: string[] = [];

    constructor(
        private readonly config: AppConfig,
        private readonly registry: SchedulerRegistry,
        private readonly recurrentSlots: RecurrentSlotsJob,
        private readonly newsExpiry: NewsExpiryJob,
        private readonly slotExpiry: SlotExpiryJob,
        private readonly staleBookings: StaleBookingsJob,
        private readonly cascadeReconcile: CascadeReconcileJob,
        private readonly storageGc: StorageGcJob,
        private readonly debtorReport: DebtorReportJob,
        private readonly unreferencedImages: UnreferencedImagesJob,
        private readonly bookingReminders: BookingRemindersJob,
        private readonly autoNoShow: AutoNoShowJob,
        private readonly outboxDispatch: OutboxDispatchJob,
        private readonly trashPurge: TrashPurgeJob,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(JobsScheduler.name);
    }

    onModuleInit(): void {
        if (!this.config.jobs.enabled) {
            this.logger.info('jobs disabled for this process (JOBS_ENABLED=false)');

            return;
        }

        for (const { name, cron, run } of this.plan()) this.schedule(name, cron, run);

        this.logger.info({ jobs: this.registered, timezone: this.config.jobs.timezone }, 'jobs scheduled');
    }

    schedules(now = new Date()): JobSchedule[] {
        const { timezone } = this.config.jobs;

        return this.plan().map(({ name, cron }) => ({
            name,
            cron,
            next_run_at: nextRunAt(cron, timezone, now),
        }));
    }

    private plan(): { name: string; cron: string; run: () => Promise<unknown> }[] {
        const { cron } = this.config.jobs;

        return [
            { name: RECURRENT_SLOTS_JOB, cron: cron.recurrentSlots, run: () => this.recurrentSlots.run() },
            { name: NEWS_EXPIRY_JOB, cron: cron.newsExpiry, run: () => this.newsExpiry.run() },
            { name: SLOT_EXPIRY_JOB, cron: cron.slotExpiry, run: () => this.slotExpiry.run() },
            { name: STALE_BOOKINGS_JOB, cron: cron.staleBookings, run: () => this.staleBookings.run() },
            {
                name: CASCADE_RECONCILE_JOB,
                cron: cron.cascadeReconcile,
                run: () => this.cascadeReconcile.run(),
            },
            { name: STORAGE_GC_JOB, cron: cron.storageGc, run: () => this.storageGc.run() },
            { name: DEBTOR_REPORT_JOB, cron: cron.debtorReport, run: () => this.debtorReport.run() },
            {
                name: UNREFERENCED_IMAGES_JOB,
                cron: cron.unreferencedImages,
                run: () => this.unreferencedImages.run(),
            },
            {
                name: BOOKING_REMINDERS_JOB,
                cron: cron.bookingReminders,
                run: () => this.bookingReminders.run(),
            },
            { name: AUTO_NO_SHOW_JOB, cron: cron.autoNoShow, run: () => this.autoNoShow.run() },
            { name: OUTBOX_DISPATCH_JOB, cron: cron.outboxDispatch, run: () => this.outboxDispatch.run() },
            { name: TRASH_PURGE_JOB, cron: cron.trashPurge, run: () => this.trashPurge.run() },
        ];
    }

    onModuleDestroy(): void {
        for (const name of this.registered) {
            try {
                this.registry.deleteCronJob(name);
            } catch {
                // A schedule that was never registered needs no removal.
            }
        }
    }

    private schedule(name: string, expression: string, run: () => Promise<unknown>): void {
        const job = new CronJob(
            expression,
            () => {
                run().catch((error: unknown) =>
                    this.logger.error({ err: error, job: name }, 'scheduled job failed'),
                );
            },
            null,
            true,
            this.config.jobs.timezone,
        );
        this.registry.addCronJob(name, job);
        this.registered.push(name);
    }
}
