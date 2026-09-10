import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ArchiveEntity } from './archives.repository';
import { ArchivesService } from './archives.service';
import {
    ArchiveResponseDto,
    archiveResponseSchema,
    CreateArchiveDto,
    ListArchivesQueryDto,
} from './dto/archive.schemas';

@ApiTags('archives')
@ApiBearerAuth()
@Controller('archives')
@Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
export class ArchivesController {
    constructor(private readonly archives: ArchivesService) {}

    @Get()
    @ApiPaginated(ArchiveResponseDto)
    @SerializePaginated(archiveResponseSchema)
    list(
        @Query() query: ListArchivesQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<ArchiveEntity>> {
        return this.archives.list(query, user);
    }

    @Post()
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: ArchiveResponseDto })
    @Serialize(archiveResponseSchema)
    async create(
        @Body() body: CreateArchiveDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<ArchiveEntity> {
        const archive = await this.archives.create(body);
        res.setHeader('Location', `/archives/${archive._id.toHexString()}`);

        return archive;
    }

    @Get(':id')
    @ApiData(ArchiveResponseDto)
    @Serialize(archiveResponseSchema)
    getOne(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ArchiveEntity> {
        return this.archives.getById(id, user);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
        await this.archives.delete(id, user);
    }
}
