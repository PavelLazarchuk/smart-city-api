import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../common/database/transaction-runner';
import { ArchivesService } from '../modules/archives/archives.service';
import { NewsService } from '../modules/news/news.service';
import { JobRunner } from './job-runner';

export const NEWS_EXPIRY_JOB = 'news_expiry';

@Injectable()
export class NewsExpiryJob {
    constructor(
        private readonly news: NewsService,
        private readonly archives: ArchivesService,
        private readonly tx: TransactionRunner,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(NEWS_EXPIRY_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ archived: number }> {
        const expired = await this.news.findExpired(now);
        let archived = 0;

        for (const item of expired) {
            await this.tx.run(async (ctx) => {
                const deleted = await this.news.deleteExpired(item._id.toHexString(), ctx);

                if (!deleted) return;

                await this.archives.createSnapshot(
                    {
                        organization_id: item.organization_id,
                        type: 'news',
                        data: { ...item, _id: item._id.toHexString() },
                    },
                    ctx.session,
                );
                archived += 1;
            });
        }

        return { archived };
    }
}
