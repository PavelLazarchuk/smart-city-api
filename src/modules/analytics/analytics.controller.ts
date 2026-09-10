import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type AnalyticsEventEntity } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import {
    AnalyticsEventResponseDto,
    analyticsEventResponseSchema,
    ListAnalyticsQueryDto,
} from './dto/analytics.schemas';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
@Roles(ROLES.SUPER_ADMIN)
export class AnalyticsController {
    constructor(private readonly analytics: AnalyticsService) {}

    @Get('events')
    @ApiPaginated(AnalyticsEventResponseDto, true)
    @SerializePaginated(analyticsEventResponseSchema)
    list(@Query() query: ListAnalyticsQueryDto): Promise<PaginatedResult<AnalyticsEventEntity>> {
        return this.analytics.list(query);
    }
}
