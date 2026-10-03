import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Roles, STAFF_ROLES } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { parseIdempotencyKey } from '../../common/idempotency/idempotency-key';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import {
    ListClientsQueryDto,
    type OrganizationClient,
    OrganizationClientDto,
    organizationClientSchema,
    SendMessageDto,
    type SentMessage,
    SentMessageDto,
    sentMessageSchema,
} from './dto/notification.schemas';
import { OrganizationMessagesService } from './organization-messages.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('organizations/:id')
@Roles(...STAFF_ROLES)
export class OrganizationMessagesController {
    constructor(private readonly messages: OrganizationMessagesService) {}

    @Post('messages')
    @OrganizationScope({ from: 'path' })
    @ApiCreatedResponse({ type: SentMessageDto })
    @ApiErrors(
        'ORGANIZATION_NOT_FOUND',
        'CLIENT_NOT_FOUND',
        'IDEMPOTENCY_IN_PROGRESS',
        'IDEMPOTENCY_KEY_REUSED',
    )
    @Serialize(sentMessageSchema)
    async send(
        @Param('id') id: string,
        @Body() body: SendMessageDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
        @Headers('idempotency-key') idempotencyKey?: string,
    ): Promise<SentMessage> {
        const { result, replayed } = await this.messages.send(
            id,
            body,
            user,
            parseIdempotencyKey(idempotencyKey),
        );

        if (replayed) res.setHeader('Idempotency-Replayed', 'true');

        return result;
    }

    @Get('clients')
    @OrganizationScope({ from: 'path' })
    @ApiPaginated(OrganizationClientDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'PAGE_OUT_OF_RANGE')
    @SerializePaginated(organizationClientSchema)
    clients(
        @Param('id') id: string,
        @Query() query: ListClientsQueryDto,
    ): Promise<PaginatedResult<OrganizationClient>> {
        return this.messages.clients(id, query);
    }
}
