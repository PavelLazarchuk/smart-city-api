import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { MetricsService } from '../../common/metrics/metrics.service';
import { SmsCounter } from './schemas/sms-counter.schema';

export type BudgetWindow = 'hour' | 'day';

export interface BudgetDecision {
    allowed: boolean;
    window?: BudgetWindow;
    limit?: number;
    used?: number;
}

/**
 * Counts messages, not requests, so it sees a thousand numbers sent from a thousand addresses. The hourly
 * window is rolled back when the daily one refuses, so a refusal costs no budget.
 */
@Injectable()
export class SmsBudgetService {
    constructor(
        @InjectModel(SmsCounter.name) private readonly counters: Model<SmsCounter>,
        private readonly config: AppConfig,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SmsBudgetService.name);
    }

    async consume(now = new Date()): Promise<BudgetDecision> {
        const { hourlyLimit, dailyLimit } = this.config.sms.budget;
        const hour = await this.charge('hour', hourlyLimit, now);

        if (!hour.allowed) return hour;

        const day = await this.charge('day', dailyLimit, now);

        if (!day.allowed) {
            await this.refund('hour', now);

            return day;
        }

        return { allowed: true };
    }

    private async charge(window: BudgetWindow, limit: number, now: Date): Promise<BudgetDecision> {
        if (limit === 0) return { allowed: true };

        const record = await this.counters
            .findOneAndUpdate(
                { _id: this.keyFor(window, now) },
                { $inc: { count: 1 }, $setOnInsert: { expires_at: this.expiryFor(window, now) } },
                { upsert: true, new: true },
            )
            .lean<SmsCounter>()
            .exec();
        const used = record?.count ?? 1;

        if (used <= limit) return { allowed: true };

        await this.refund(window, now);
        this.metrics.countSmsBudgetBlock(window);
        this.logger.error(
            { window, limit, used: used - 1 },
            'sms budget exhausted: outgoing messages are being refused',
        );

        return { allowed: false, window, limit, used: used - 1 };
    }

    private async refund(window: BudgetWindow, now: Date): Promise<void> {
        await this.counters.updateOne({ _id: this.keyFor(window, now) }, { $inc: { count: -1 } }).exec();
    }

    private keyFor(window: BudgetWindow, now: Date): string {
        const iso = now.toISOString();

        return window === 'hour' ? `sms:hour:${iso.slice(0, 13)}` : `sms:day:${iso.slice(0, 10)}`;
    }

    private expiryFor(window: BudgetWindow, now: Date): Date {
        const ttlMs = window === 'hour' ? 2 * 3600_000 : 48 * 3600_000;

        return new Date(now.getTime() + ttlMs);
    }
}
