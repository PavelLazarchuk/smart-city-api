import { Injectable } from '@nestjs/common';

import { AppConfig } from '../common/config/app-config';
import { ServicesService } from '../modules/services/services.service';
import { JobRunner } from './job-runner';

export const TRASH_PURGE_JOB = 'trash_purge';

@Injectable()
export class TrashPurgeJob {
    constructor(
        private readonly services: ServicesService,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(TRASH_PURGE_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ purged: number }> {
        const before = new Date(now.getTime() - this.config.retention.serviceTrashDays * 24 * 60 * 60 * 1000);
        let purged = 0;

        for (;;) {
            const batch = await this.services.purgeTrash(before, 100);
            purged += batch;

            if (batch < 100) break;
        }

        return { purged };
    }
}
