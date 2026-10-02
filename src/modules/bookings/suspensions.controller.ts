import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, STAFF_ROLES } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { SuspensionsService } from '../services/suspensions.service';
import {
    CreateSuspensionDto,
    ListSuspensionsQueryDto,
    type SuspensionResource,
    SuspensionResourceDto,
    suspensionResourceSchema,
} from './dto/suspension.schemas';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('suspensions')
@Roles(...STAFF_ROLES)
export class SuspensionsController {
    constructor(private readonly suspensions: SuspensionsService) {}

    @Get()
    @ApiPaginated(SuspensionResourceDto)
    @SerializePaginated(suspensionResourceSchema)
    list(
        @Query() query: ListSuspensionsQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<SuspensionResource>> {
        return this.suspensions.list(query, user);
    }

    @Post()
    @ApiCreatedResponse({ type: SuspensionResourceDto })
    @ApiErrors('SERVICE_NOT_FOUND', 'USER_NOT_FOUND', 'CLIENT_ACCOUNT_REQUIRED')
    @Serialize(suspensionResourceSchema)
    async create(
        @Body() body: CreateSuspensionDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<SuspensionResource> {
        const suspension = await this.suspensions.create(body, user);
        res.setHeader('Location', `/suspensions/${suspension.id}`);

        return suspension;
    }

    @Get(':id')
    @ApiData(SuspensionResourceDto)
    @ApiErrors('SUSPENSION_NOT_FOUND')
    @Serialize(suspensionResourceSchema)
    getOne(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<SuspensionResource> {
        return this.suspensions.getById(id, user);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('SUSPENSION_NOT_FOUND')
    async lift(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
        await this.suspensions.lift(id, user);
    }
}
