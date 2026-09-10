import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';

import { AppConfig } from '../common/config/app-config';
import { JobLock } from './schemas/job-lock.schema';

export interface Lease {
    job: string;
    holder: string;
    renew(): Promise<void>;
    release(): Promise<void>;
}

/**
 * Distributed lock in `job_locks`: one atomic `findOneAndUpdate` upsert acquires it, a
 * duplicate-key error means another holder has it, a crashed holder's lease simply expires.
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
                    { $set: { locked_until: new Date(now.getTime() + this.ttlMs), holder } },
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
}
