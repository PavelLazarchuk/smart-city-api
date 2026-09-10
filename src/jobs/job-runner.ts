import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { JobLockService } from './job-lock.service';

export interface JobOutcome {
    ran: boolean;
    duration_ms: number;
    result?: unknown;
}

/** Runs a job under the distributed lock, renewing the lease while it executes, with structured logs. */
@Injectable()
export class JobRunner {
    constructor(
        private readonly locks: JobLockService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(JobRunner.name);
    }

    async run(job: string, work: () => Promise<unknown>): Promise<JobOutcome> {
        const started = Date.now();
        const lease = await this.locks.acquire(job);

        if (!lease) {
            this.logger.info({ job }, 'job skipped: lock held elsewhere');

            return { ran: false, duration_ms: Date.now() - started };
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

            return { ran: true, duration_ms: duration, result };
        } catch (error) {
            this.logger.error({ err: error, job, duration_ms: Date.now() - started }, 'job failed');
            throw error;
        } finally {
            clearInterval(timer);
            await lease
                .release()
                .catch((error: unknown) => this.logger.warn({ err: error, job }, 'lease release failed'));
        }
    }
}
