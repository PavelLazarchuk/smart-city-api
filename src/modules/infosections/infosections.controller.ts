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
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import {
    CreateInfoSectionDto,
    type CreateInfoSectionInput,
    InfoSectionResponseDto,
    infoSectionResponseSchema,
    ListInfoSectionsQueryDto,
    UpdateInfoSectionDto,
} from './dto/infosection.schemas';
import { type InfoSectionEntity } from './infosections.repository';
import { InfoSectionsService } from './infosections.service';

@ApiTags('infosections')
@Controller('infosections')
export class InfoSectionsController {
    constructor(private readonly infosections: InfoSectionsService) {}

    @Get()
    @Public()
    @ApiPaginated(InfoSectionResponseDto)
    @SerializePaginated(infoSectionResponseSchema)
    list(@Query() query: ListInfoSectionsQueryDto): Promise<PaginatedResult<InfoSectionEntity>> {
        return this.infosections.list(query);
    }

    @Get(':id')
    @Public()
    @ApiData(InfoSectionResponseDto)
    @Serialize(infoSectionResponseSchema)
    getOne(@Param('id') id: string): Promise<InfoSectionEntity> {
        return this.infosections.getById(id);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: InfoSectionResponseDto })
    @Serialize(infoSectionResponseSchema)
    async create(
        @Body() body: CreateInfoSectionDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<InfoSectionEntity> {
        const item = await this.infosections.create(body as CreateInfoSectionInput);
        res.setHeader('Location', `/infosections/${item._id.toHexString()}`);

        return item;
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'infosection' })
    @ApiData(InfoSectionResponseDto)
    @Serialize(infoSectionResponseSchema)
    update(@Param('id') id: string, @Body() body: UpdateInfoSectionDto): Promise<InfoSectionEntity> {
        return this.infosections.update(id, body);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'infosection' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.infosections.delete(id);
    }
}
