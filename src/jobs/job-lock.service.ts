import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Model, type UpdateQuery } from 'mongoose';

import { AppConfig } from '../common/config/app-config';
import { JobLock, type JobRunStatus } from './schemas/job-lock.schema';

export interface Lease {
    job: string;
    holder: string;
    renew(): Promise<void>;
    release(): Promise<void>;
}

export interface JobRunOutcome {
    status: JobRunStatus;
    durationMs: number;
    error?: string;
    at?: Date;
}

export type JobStatus = JobLock;

const ERROR_MAX_LENGTH = 500;

/**
 * Distributed lock in `job_locks`: one atomic `findOneAndUpdate` upsert acquires it, a
 * duplicate-key error means another holder has it, a crashed holder's lease simply expires.
 * The same document records how the last run ended — see {@link JobLock}.
 */
@Injectable()
export class JobLockService {
    readonly holderId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

    constructor(
        @InjectModel(JobLock.name) private readonly model: Model<JobLock>,
        private readonly config: AppConfig,
    ) {}

    get ttlMs(): number {
        return this.config.jobs.lockTtlSeconds * 1000;
    }

    async acquire(job: string): Promise<Lease | null> {
        const holder = this.holderId;
        const now = new Date();
        try {
            const doc = await this.model
                .findOneAndUpdate(
                    { _id: job, locked_until: { $lt: now } },
                    {
                        $set: {
                            locked_until: new Date(now.getTime() + this.ttlMs),
                            holder,
                            last_started_at: now,
                        },
                    },
                    { upsert: true, new: true },
                )
                .lean<JobLock>()
                .exec();

            if (!doc || doc.holder !== holder) return null;
        } catch (error) {
            if ((error as { code?: number }).code === 11000) return null;

            throw error;
        }

        return {
            job,
            holder,
            renew: async () => {
                await this.model
                    .updateOne(
                        { _id: job, holder },
                        { $set: { locked_until: new Date(Date.now() + this.ttlMs) } },
                    )
                    .exec();
            },
            release: async () => {
                await this.model
                    .updateOne({ _id: job, holder }, { $set: { locked_until: new Date(0) } })
                    .exec();
            },
        };
    }

    /** Records how a run ended. A run skipped for a held lease records nothing — it did not run. */
    async markFinished(job: string, outcome: JobRunOutcome): Promise<void> {
        const at = outcome.at ?? new Date();
        const set: Record<string, unknown> = {
            last_finished_at: at,
            last_status: outcome.status,
            last_duration_ms: outcome.durationMs,
        };
        const update: UpdateQuery<JobLock> = { $set: set };

        if (outcome.status === 'ok') {
            set['last_success_at'] = at;
            set['consecutive_failures'] = 0;
            update.$unset = { last_error: 1 };
        } else {
            set['last_error'] = (outcome.error ?? 'unknown error').slice(0, ERROR_MAX_LENGTH);
            update.$inc = { consecutive_failures: 1 };
        }

        await this.model.updateOne({ _id: job }, update).exec();
    }

    /** Every known job with its lease and last outcome, for `GET /health/jobs`. */
    statuses(): Promise<JobStatus[]> {
        return this.model.find().sort({ _id: 1 }).lean<JobStatus[]>().exec();
    }
}
