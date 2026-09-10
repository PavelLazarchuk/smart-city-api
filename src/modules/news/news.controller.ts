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
    CreateNewsDto,
    ListNewsQueryDto,
    NewsResponseDto,
    newsResponseSchema,
    UpdateNewsDto,
} from './dto/news.schemas';
import { type NewsEntity } from './news.repository';
import { NewsService } from './news.service';

@ApiTags('news')
@Controller('news')
export class NewsController {
    constructor(private readonly news: NewsService) {}

    @Get()
    @Public()
    @ApiPaginated(NewsResponseDto)
    @SerializePaginated(newsResponseSchema)
    list(@Query() query: ListNewsQueryDto): Promise<PaginatedResult<NewsEntity>> {
        return this.news.list(query);
    }

    @Get(':id')
    @Public()
    @ApiData(NewsResponseDto)
    @Serialize(newsResponseSchema)
    getOne(@Param('id') id: string): Promise<NewsEntity> {
        return this.news.getById(id);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: NewsResponseDto })
    @Serialize(newsResponseSchema)
    async create(
        @Body() body: CreateNewsDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<NewsEntity> {
        const item = await this.news.create(body);
        res.setHeader('Location', `/news/${item._id.toHexString()}`);

        return item;
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'news' })
    @ApiData(NewsResponseDto)
    @Serialize(newsResponseSchema)
    update(@Param('id') id: string, @Body() body: UpdateNewsDto): Promise<NewsEntity> {
        return this.news.update(id, body);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'news' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.news.delete(id);
    }
}
