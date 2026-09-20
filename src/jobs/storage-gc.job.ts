import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../common/config/app-config';
import { STORAGE_PROVIDER, type StorageProvider } from '../integrations/storage/storage.provider';
import { ImagesRepository } from '../modules/images/images.repository';
import { JobRunner } from './job-runner';

export const STORAGE_GC_JOB = 'storage_gc';

const BATCH = 200;

/** Only a key of exactly the upload path's shape is a candidate, so anything else in the bucket is untouchable. */
const MANAGED_KEY = /^[0-9a-f]{24}\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

/**
 * A delete whose file removal failed leaves a file nothing will ever retry. `STORAGE_GC_MIN_AGE` covers the
 * window between `put` and the row, and the row lookup happens per batch, right before the delete.
 */
@Injectable()
export class StorageGcJob {
    constructor(
        @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
        private readonly images: ImagesRepository,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(StorageGcJob.name);
    }

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(STORAGE_GC_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ scanned: number; orphans: number; bytes_freed: number }> {
        const cutoff = new Date(now.getTime() - this.config.jobs.storageGcMinAgeSeconds * 1000);
        const summary = { scanned: 0, orphans: 0, bytes_freed: 0 };
        let batch: { key: string; size: number }[] = [];

        for await (const object of this.storage.list()) {
            summary.scanned += 1;

            if (!MANAGED_KEY.test(object.key) || object.modified_at.getTime() > cutoff.getTime()) continue;

            batch.push({ key: object.key, size: object.size });

            if (batch.length < BATCH) continue;

            await this.sweep(batch, summary);
            batch = [];
        }

        await this.sweep(batch, summary);

        return summary;
    }

    private async sweep(
        batch: { key: string; size: number }[],
        summary: { orphans: number; bytes_freed: number },
    ): Promise<void> {
        if (batch.length === 0) return;

        const known = await this.images.existingNames(batch.map((object) => object.key));

        for (const object of batch) {
            if (known.has(object.key)) continue;

            try {
                await this.storage.delete(object.key);
                summary.orphans += 1;
                summary.bytes_freed += object.size;
                this.logger.warn({ key: object.key, size: object.size }, 'orphan file removed from storage');
            } catch (error) {
                // One unreadable key must not end the sweep; the next run sees the file again.
                this.logger.error({ err: error, key: object.key }, 'orphan file could not be removed');
            }
        }
    }
}
