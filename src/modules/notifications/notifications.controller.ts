import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import {
    ListNotificationsQueryDto,
    type NotificationResource,
    NotificationResourceDto,
    notificationResourceSchema,
    ReadAllDto,
    ReadAllResponseDto,
    readAllResponseSchema,
    type ReadAllResult,
    type UnreadCount,
    UnreadCountQueryDto,
    UnreadCountResponseDto,
    unreadCountResponseSchema,
} from './dto/notification.schemas';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
    constructor(private readonly notifications: NotificationsService) {}

    @Get()
    @ApiPaginated(NotificationResourceDto)
    @ApiErrors('PAGE_OUT_OF_RANGE')
    @SerializePaginated(notificationResourceSchema)
    list(
        @Query() query: ListNotificationsQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<NotificationResource>> {
        return this.notifications.list(user, query);
    }

    @Get('unread-count')
    @ApiData(UnreadCountResponseDto)
    @Serialize(unreadCountResponseSchema)
    unreadCount(@Query() query: UnreadCountQueryDto, @CurrentUser() user: AuthUser): Promise<UnreadCount> {
        return this.notifications.unreadCount(user, query);
    }

    @Post('read-all')
    @HttpCode(HttpStatus.OK)
    @ApiData(ReadAllResponseDto)
    @Serialize(readAllResponseSchema)
    readAll(@Body() body: ReadAllDto, @CurrentUser() user: AuthUser): Promise<ReadAllResult> {
        return this.notifications.markAllRead(user, body);
    }

    @Post(':id/read')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('NOTIFICATION_NOT_FOUND')
    async read(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
        await this.notifications.markRead(user, id);
    }
}
