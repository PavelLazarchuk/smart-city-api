import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { MetricsService } from '../../common/metrics/metrics.service';
import { type ApiErrorDetail } from '../../common/http/api-error';
import { type SettingsWarning } from '../../common/settings/dto/settings.schemas';
import {
    type SettingsChange,
    SettingsService,
    settingLockoutRisk,
} from '../../common/settings/settings.service';
import { SmsCounter } from './schemas/sms-counter.schema';

export type BudgetWindow = 'hour' | 'day';

const LIMIT_WINDOWS = [
    ['sms.hourly_limit', 'hour'],
    ['sms.daily_limit', 'day'],
] as const;

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
export class SmsBudgetService implements OnModuleInit {
    constructor(
        @InjectModel(SmsCounter.name) private readonly counters: Model<SmsCounter>,
        private readonly settings: SettingsService,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SmsBudgetService.name);
    }

    onModuleInit(): void {
        this.settings.registerWriteCheck('sms.staff_sign_in_codes', (change) =>
            this.checkStaffSignIn(change),
        );
    }

    async consume(now = new Date()): Promise<BudgetDecision> {
        const hour = await this.charge('hour', this.settings.get('sms.hourly_limit'), now);

        if (!hour.allowed) return hour;

        const day = await this.charge('day', this.settings.get('sms.daily_limit'), now);

        if (!day.allowed) {
            await this.refund('hour', now);

            return day;
        }

        return { allowed: true };
    }

    private async checkStaffSignIn(change: SettingsChange): Promise<SettingsWarning[]> {
        if (change.after['auth.admin_login_method'] !== 'sms') return [];

        const switched = change.before['auth.admin_login_method'] !== 'sms';
        const now = new Date();
        const details: ApiErrorDetail[] = [];

        for (const [key, window] of LIMIT_WINDOWS) {
            const limit = change.after[key];
            const before = change.before[key];

            if (limit === 0 || (!switched && before !== 0 && limit >= before)) continue;

            const used = await this.used(window, now);

            if (used >= limit)
                details.push({
                    path: key,
                    message: `${used} SMS were already sent this ${window}; a limit of ${limit} leaves no sign-in code for staff until it ends`,
                });
        }

        if (details.length > 0) throw settingLockoutRisk(details);

        return [];
    }

    private async used(window: BudgetWindow, now: Date): Promise<number> {
        const record = await this.counters.findById(this.keyFor(window, now)).lean<SmsCounter>().exec();

        return record?.count ?? 0;
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
