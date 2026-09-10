import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { RequestContext } from '../../common/context/request-context';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { type EventType } from '../../common/decorators/track-event.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { usesCursorMode } from '../../common/pagination/pagination.schema';
import { PaginationService } from '../../common/pagination/pagination.service';
import { type AnalyticsEventEntity, AnalyticsRepository } from './analytics.repository';
import { type ListAnalyticsQuery } from './dto/analytics.schemas';

export interface EventFields {
    user_id?: string;
    user_role?: string;
    user_name?: string;
    user_phone?: string;
    organization_id?: string;
    organization_label?: string;
    service_id?: string;
    service_label?: string;
    service_type?: string;
    child_type?: string;
    date?: string;
    time?: string;
}

const OBJECT_ID_FIELDS = ['user_id', 'organization_id', 'service_id'] as const;

@Injectable()
export class AnalyticsService {
    constructor(
        private readonly events: AnalyticsRepository,
        private readonly pagination: PaginationService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(AnalyticsService.name);
    }

    /** Non-blocking write; failures are logged, never surfaced to the request. */
    record(type: EventType, fields: EventFields, actor?: AuthUser): void {
        const document: Record<string, unknown> = { type, request_id: RequestContext.requestId() };

        if (actor) {
            document['user_id'] = new Types.ObjectId(actor.id);
            document['user_role'] = actor.role;
            document['user_name'] = actor.name;
            document['user_phone'] = actor.phone;
        }

        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === null) continue;

            if ((OBJECT_ID_FIELDS as readonly string[]).includes(key) && typeof value === 'string') {
                if (Types.ObjectId.isValid(value)) document[key] = new Types.ObjectId(value);

                continue;
            }

            document[key] = value;
        }

        void this.events.create(document).catch((error: unknown) => {
            this.logger.error({ err: error, type }, 'analytics event was not recorded');
        });
    }

    list(query: ListAnalyticsQuery): Promise<PaginatedResult<AnalyticsEventEntity>> {
        const filter: Record<string, unknown> = {};

        if (query.type) filter['type'] = query.type;

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.user_id) filter['user_id'] = new Types.ObjectId(query.user_id);

        if (query.user_role) filter['user_role'] = query.user_role;

        if (query.from || query.to) {
            filter['created_at'] = {
                ...(query.from ? { $gte: new Date(query.from) } : {}),
                ...(query.to ? { $lte: new Date(query.to) } : {}),
            };
        }

        if (usesCursorMode(query)) {
            const limit = Math.min(
                query.limit ?? this.pagination.resolve({}, { sortable: [], defaultSort: '_id' }).limit,
                this.pagination.maxLimit,
            );

            return this.events.paginateByCursor(filter, query.cursor, limit);
        }

        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'type'],
            defaultSort: 'created_at',
        });

        return this.events.paginate(filter, pagination);
    }
}
