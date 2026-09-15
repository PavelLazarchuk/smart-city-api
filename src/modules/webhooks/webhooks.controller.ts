import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type OutboxEventEntity } from '../../common/outbox/outbox.repository';
import { type WebhookEntity } from '../../common/outbox/webhooks.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import {
    CreateWebhookDto,
    ListOutboxQueryDto,
    ListWebhooksQueryDto,
    OutboxEventResponseDto,
    outboxEventResponseSchema,
    UpdateWebhookDto,
    WebhookCreatedResponseDto,
    webhookCreatedResponseSchema,
    WebhookResponseDto,
    webhookResponseSchema,
    WebhookTestResponseDto,
    webhookTestResponseSchema,
} from './dto/webhook.schemas';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@ApiBearerAuth()
@Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
@Controller()
export class WebhooksController {
    constructor(private readonly webhooks: WebhooksService) {}

    @Get('webhooks')
    @ApiPaginated(WebhookResponseDto)
    @SerializePaginated(webhookResponseSchema)
    list(
        @Query() query: ListWebhooksQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<WebhookEntity>> {
        return this.webhooks.list(query, user);
    }

    @Post('webhooks')
    @ApiCreatedResponse({ type: WebhookCreatedResponseDto })
    @ApiErrors('ORGANIZATION_NOT_FOUND')
    @Serialize(webhookCreatedResponseSchema)
    async create(
        @Body() body: CreateWebhookDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<WebhookEntity> {
        const webhook = await this.webhooks.create(body, user);
        res.setHeader('Location', `/webhooks/${webhook._id.toHexString()}`);

        return webhook;
    }

    @Get('webhooks/:id')
    @ApiData(WebhookResponseDto)
    @ApiErrors('WEBHOOK_NOT_FOUND')
    @Serialize(webhookResponseSchema)
    getOne(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<WebhookEntity> {
        return this.webhooks.getById(id, user);
    }

    @Patch('webhooks/:id')
    @ApiData(WebhookResponseDto)
    @ApiErrors('WEBHOOK_NOT_FOUND')
    @Serialize(webhookResponseSchema)
    update(
        @Param('id') id: string,
        @Body() body: UpdateWebhookDto,
        @CurrentUser() user: AuthUser,
    ): Promise<WebhookEntity> {
        return this.webhooks.update(id, body, user);
    }

    @Post('webhooks/:id/rotate-secret')
    @HttpCode(HttpStatus.OK)
    @ApiData(WebhookCreatedResponseDto)
    @ApiErrors('WEBHOOK_NOT_FOUND')
    @Serialize(webhookCreatedResponseSchema)
    rotate(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<WebhookEntity> {
        return this.webhooks.rotateSecret(id, user);
    }

    @Post('webhooks/:id/test')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiData(WebhookTestResponseDto, 202)
    @ApiErrors('WEBHOOK_NOT_FOUND')
    @Serialize(webhookTestResponseSchema)
    test(
        @Param('id') id: string,
        @CurrentUser() user: AuthUser,
    ): Promise<{ event_id: string; queued: true }> {
        return this.webhooks.test(id, user);
    }

    @Delete('webhooks/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('WEBHOOK_NOT_FOUND')
    async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
        await this.webhooks.delete(id, user);
    }

    @Get('outbox/events')
    @ApiPaginated(OutboxEventResponseDto)
    @SerializePaginated(outboxEventResponseSchema)
    events(
        @Query() query: ListOutboxQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<OutboxEventEntity>> {
        return this.webhooks.listEvents(query, user);
    }

    @Post('outbox/events/:id/replay')
    @HttpCode(HttpStatus.OK)
    @ApiData(OutboxEventResponseDto)
    @ApiErrors('NOT_FOUND', 'CONFLICT')
    @Serialize(outboxEventResponseSchema)
    replay(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<OutboxEventEntity> {
        return this.webhooks.replayEvent(id, user);
    }
}
