import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { MetricsService } from '../common/metrics/metrics.service';
import { JobLockService, type JobRunOutcome } from './job-lock.service';

export interface JobOutcome {
    ran: boolean;
    duration_ms: number;
    result?: unknown;
}

/** The outcome is written to the lease, so a job that throws every night is visible in `GET /health/jobs`. */
@Injectable()
export class JobRunner {
    constructor(
        private readonly locks: JobLockService,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(JobRunner.name);
    }

    async run(job: string, work: () => Promise<unknown>): Promise<JobOutcome> {
        const started = Date.now();
        const lease = await this.locks.acquire(job);

        if (!lease) {
            const duration = Date.now() - started;
            this.logger.info({ job }, 'job skipped: lock held elsewhere');
            this.metrics.observeJob(job, 'skipped', duration);

            return { ran: false, duration_ms: duration };
        }

        this.logger.info({ job, holder: lease.holder }, 'job started');
        const renewEvery = Math.max(1000, Math.floor(this.locks.ttlMs / 3));
        const timer = setInterval(() => {
            void lease
                .renew()
                .catch((error: unknown) => this.logger.warn({ err: error, job }, 'lease renewal failed'));
        }, renewEvery);
        try {
            const result = await work();
            const duration = Date.now() - started;
            this.logger.info({ job, duration_ms: duration, result }, 'job finished');
            this.metrics.observeJob(job, 'ok', duration);
            await this.record(job, { status: 'ok', durationMs: duration });

            return { ran: true, duration_ms: duration, result };
        } catch (error) {
            const duration = Date.now() - started;
            this.logger.error({ err: error, job, duration_ms: duration }, 'job failed');
            this.metrics.observeJob(job, 'failed', duration);
            await this.record(job, {
                status: 'failed',
                durationMs: duration,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            clearInterval(timer);
            await lease
                .release()
                .catch((error: unknown) => this.logger.warn({ err: error, job }, 'lease release failed'));
        }
    }

    /** Bookkeeping must never become the reason a job reports failure, so its own error only logs. */
    private async record(job: string, outcome: JobRunOutcome): Promise<void> {
        try {
            await this.locks.markFinished(job, outcome);
        } catch (error) {
            this.logger.warn({ err: error, job }, 'job outcome could not be recorded');
        }
    }
}
