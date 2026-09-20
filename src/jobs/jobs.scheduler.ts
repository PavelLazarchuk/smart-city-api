import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../common/config/app-config';
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

        const { cron, timezone } = this.config.jobs;
        this.schedule(RECURRENT_SLOTS_JOB, cron.recurrentSlots, () => this.recurrentSlots.run());
        this.schedule(NEWS_EXPIRY_JOB, cron.newsExpiry, () => this.newsExpiry.run());
        this.schedule(SLOT_EXPIRY_JOB, cron.slotExpiry, () => this.slotExpiry.run());
        this.schedule(STALE_BOOKINGS_JOB, cron.staleBookings, () => this.staleBookings.run());
        this.schedule(CASCADE_RECONCILE_JOB, cron.cascadeReconcile, () => this.cascadeReconcile.run());
        this.schedule(STORAGE_GC_JOB, cron.storageGc, () => this.storageGc.run());
        this.schedule(DEBTOR_REPORT_JOB, cron.debtorReport, () => this.debtorReport.run());
        this.schedule(UNREFERENCED_IMAGES_JOB, cron.unreferencedImages, () => this.unreferencedImages.run());
        this.schedule(BOOKING_REMINDERS_JOB, cron.bookingReminders, () => this.bookingReminders.run());
        this.schedule(OUTBOX_DISPATCH_JOB, cron.outboxDispatch, () => this.outboxDispatch.run());
        this.schedule(TRASH_PURGE_JOB, cron.trashPurge, () => this.trashPurge.run());
        this.logger.info({ jobs: this.registered, timezone }, 'jobs scheduled');
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
