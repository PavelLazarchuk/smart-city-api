import { Injectable } from '@nestjs/common';

import { SettingsService } from '../common/settings/settings.service';
import { DAY_MS } from '../common/time/zone';
import { ServicesService } from '../modules/services/services.service';
import { JobRunner } from './job-runner';

export const TRASH_PURGE_JOB = 'trash_purge';

@Injectable()
export class TrashPurgeJob {
    constructor(
        private readonly services: ServicesService,
        private readonly settings: SettingsService,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(TRASH_PURGE_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ purged: number }> {
        const before = new Date(now.getTime() - this.settings.get('retention.service_trash_days') * DAY_MS);
        let purged = 0;

        for (;;) {
            const batch = await this.services.purgeTrash(before, 100);
            purged += batch;

            if (batch < 100) break;
        }

        return { purged };
    }
}
