import { Inject, Injectable } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import { endOfMonth, startOfMonth, subMonths } from 'date-fns';
import { type FilterQuery } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { ApiError } from '../../common/http/api-error';
import { MetricsService } from '../../common/metrics/metrics.service';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { usesCursorMode } from '../../common/pagination/pagination.schema';
import { PaginationService } from '../../common/pagination/pagination.service';
import { SettingsService } from '../../common/settings/settings.service';
import { inSpan } from '../../common/tracing/spans';
import { SMS_PROVIDER, type SmsProvider } from '../../integrations/sms/sms.provider';
import { VIBER_PROVIDER, type ViberProvider } from '../../integrations/viber/viber.provider';
import { type ListSmsQuery } from './dto/sms.schemas';
import {
    type PhoneChannel,
    type Sms,
    type SmsChannel,
    type SmsPurpose,
    type SmsStatus,
} from './schemas/sms.schema';
import { SmsBudgetService } from './sms-budget.service';
import { type SmsEntity, SmsRepository } from './sms.repository';

export type PhoneRender = (channel: PhoneChannel) => Promise<string>;

@Injectable()
export class SmsService {
    constructor(
        @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
        @Inject(VIBER_PROVIDER) private readonly viber: ViberProvider | null,
        private readonly settings: SettingsService,
        private readonly sms: SmsRepository,
        private readonly budget: SmsBudgetService,
        private readonly pagination: PaginationService,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SmsService.name);
    }

    /** The budget is charged before the provider is called, so an exhausted budget costs nothing but a row. */
    async send(phone: string, text: string, purpose: SmsPurpose): Promise<SmsStatus> {
        const decision = await this.budget.consume();

        if (!decision.allowed) {
            await this.record(phone, purpose, 'blocked');
            throw ApiError.unprocessable('SMS_BUDGET_EXCEEDED');
        }

        try {
            await inSpan(
                'sms send',
                {
                    kind: SpanKind.CLIENT,
                    attributes: { 'sms.provider': this.provider.name, 'sms.purpose': purpose },
                },
                () => this.provider.send(phone, text),
            );
            await this.record(phone, purpose, 'sent');

            return 'sent';
        } catch (error) {
            this.logger.error({ err: error, purpose }, 'sms delivery failed');
            await this.record(phone, purpose, 'failed');
            throw ApiError.unprocessable('SMS_DELIVERY_FAILED');
        }
    }

    async notify(phone: string, purpose: SmsPurpose, render: PhoneRender): Promise<SmsStatus> {
        if (!this.viber || !this.settings.get('viber.enabled'))
            return this.send(phone, await render('sms'), purpose);

        const fallback = this.settings.get('viber.sms_fallback') && (await this.budget.consume()).allowed;

        return this.sendViber(phone, await render('viber'), fallback ? await render('sms') : null, purpose);
    }

    async sendViber(
        phone: string,
        text: string,
        fallbackSms: string | null,
        purpose: SmsPurpose,
    ): Promise<SmsStatus> {
        const viber = this.viber;

        if (!viber) throw ApiError.unprocessable('VIBER_NOT_CONFIGURED');

        const channel: SmsChannel = fallbackSms === null ? 'viber' : 'viber_sms';

        try {
            await inSpan(
                'viber send',
                {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'viber.provider': viber.name,
                        'sms.purpose': purpose,
                        'viber.sms_fallback': fallbackSms !== null,
                    },
                },
                () => viber.send({ phone, text, fallbackSms }),
            );
            await this.record(phone, purpose, 'sent', viber.name, channel);

            return 'sent';
        } catch (error) {
            this.logger.error({ err: error, purpose }, 'viber delivery failed');
            await this.record(phone, purpose, 'failed', viber.name, channel);
            throw ApiError.unprocessable('VIBER_DELIVERY_FAILED');
        }
    }

    async list(query: ListSmsQuery): Promise<PaginatedResult<SmsEntity>> {
        const { from, to } = this.range(query);
        const filter: FilterQuery<Sms> = {};

        if (from || to)
            filter['created_at'] = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };

        if (query.phone) filter['phone'] = query.phone;

        if (query.channel) filter['channel'] = query.channel;

        const summary = { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };

        if (usesCursorMode(query)) {
            const limit = Math.min(
                query.limit ?? this.pagination.resolve({}, { sortable: [], defaultSort: '_id' }).limit,
                this.pagination.maxLimit,
            );
            const result = await this.sms.paginateByCursor(
                filter,
                query.cursor,
                limit,
                query.with_total ?? false,
            );

            return { ...result, meta_extra: { summary: { ...summary, total: result.total } } };
        }

        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'phone'],
            defaultSort: 'created_at',
        });
        const result = await this.sms.paginate(filter, pagination);

        return { ...result, meta_extra: { summary: { ...summary, total: result.total } } };
    }

    private async record(
        phone: string,
        purpose: SmsPurpose,
        status: SmsStatus,
        provider = this.provider.name,
        channel: SmsChannel = 'sms',
    ): Promise<void> {
        this.metrics.countSms(provider, purpose, status);
        await this.sms.create({ phone, purpose, provider, status, channel });
    }

    private range(query: ListSmsQuery): { from?: Date; to?: Date } {
        const now = new Date();

        if (query.period === 'this_month') return { from: startOfMonth(now), to: now };

        if (query.period === 'last_month') {
            const previous = subMonths(now, 1);

            return { from: startOfMonth(previous), to: endOfMonth(previous) };
        }

        return {
            from: query.from ? new Date(query.from) : undefined,
            to: query.to ? new Date(query.to) : undefined,
        };
    }
}
