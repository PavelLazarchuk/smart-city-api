import { Inject, Injectable } from '@nestjs/common';
import { endOfMonth, startOfMonth, subMonths } from 'date-fns';
import { PinoLogger } from 'nestjs-pino';

import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { usesCursorMode } from '../../common/pagination/pagination.schema';
import { PaginationService } from '../../common/pagination/pagination.service';
import { SMS_PROVIDER, type SmsProvider } from '../../integrations/sms/sms.provider';
import { type ListSmsQuery } from './dto/sms.schemas';
import { type SmsPurpose } from './schemas/sms.schema';
import { type SmsEntity, SmsRepository } from './sms.repository';

@Injectable()
export class SmsService {
    constructor(
        @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
        private readonly sms: SmsRepository,
        private readonly pagination: PaginationService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SmsService.name);
    }

    /** Every attempt is logged; a provider failure surfaces as 422, never as a 5xx. */
    async send(phone: string, text: string, purpose: SmsPurpose): Promise<'sent' | 'failed'> {
        try {
            await this.provider.send(phone, text);
            await this.sms.create({ phone, purpose, provider: this.provider.name, status: 'sent' });

            return 'sent';
        } catch (error) {
            this.logger.error({ err: error, purpose }, 'sms delivery failed');
            await this.sms.create({ phone, purpose, provider: this.provider.name, status: 'failed' });
            throw ApiError.unprocessable('SMS_DELIVERY_FAILED');
        }
    }

    async list(query: ListSmsQuery): Promise<PaginatedResult<SmsEntity>> {
        const { from, to } = this.range(query);
        const filter: Record<string, unknown> = {};

        if (from || to)
            filter['created_at'] = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };

        if (query.phone) filter['phone'] = query.phone;

        const summary = { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };

        if (usesCursorMode(query)) {
            const limit = Math.min(
                query.limit ?? this.pagination.resolve({}, { sortable: [], defaultSort: '_id' }).limit,
                this.pagination.maxLimit,
            );
            const result = await this.sms.paginateByCursor(filter, query.cursor, limit);

            return { ...result, meta_extra: { summary: { ...summary, total: result.total } } };
        }

        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'phone'],
            defaultSort: 'created_at',
        });
        const result = await this.sms.paginate(filter, pagination);

        return { ...result, meta_extra: { summary: { ...summary, total: result.total } } };
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
