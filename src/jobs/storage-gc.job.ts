import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../common/config/app-config';
import { STORAGE_PROVIDER, type StorageProvider } from '../integrations/storage/storage.provider';
import { ImagesRepository } from '../modules/images/images.repository';
import { JobRunner } from './job-runner';

export const STORAGE_GC_JOB = 'storage_gc';

const BATCH = 200;

/**
 * Storage keys are written as `<organization id>/<uuid><extension>` by the upload path, and only a
 * key of exactly that shape is ever a candidate for deletion. A bucket shared with anything else —
 * a backup, a static asset, a hand-copied file — is then untouchable by this job by construction.
 */
const MANAGED_KEY = /^[0-9a-f]{24}\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

/**
 * Deletes stored files that no `images` row points at.
 *
 * An image is removed row first, file after the commit ([`ImagesService`](../modules/images/images.service.ts)),
 * which is the right order — a rolled-back delete must never lose a file — but it leaves the file behind for
 * good if the store happens to be unreachable at that moment. Nothing refers to it any more, so nothing will
 * ever retry: without this sweep the bucket only grows.
 *
 * Two guards keep a live upload safe. A file is considered only once it is older than
 * `STORAGE_GC_MIN_AGE`, which covers the window between `put` and the row being written; and the row
 * lookup happens per batch, immediately before the delete, not from a snapshot taken at the start.
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
