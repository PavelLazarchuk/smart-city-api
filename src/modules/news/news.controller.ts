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

import { AppConfig } from '../../common/config/app-config';
import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import {
    CreateNewsDto,
    ListNewsQueryDto,
    NewsResponseDto,
    newsResponseSchema,
    RssQueryDto,
    UpdateNewsDto,
} from './dto/news.schemas';
import { type NewsEntity } from './news.repository';
import { NewsService } from './news.service';
import { renderRss } from './rss';

@ApiTags('news')
@Controller('news')
export class NewsController {
    constructor(
        private readonly news: NewsService,
        private readonly config: AppConfig,
    ) {}

    @Get()
    @Public()
    @ApiPaginated(NewsResponseDto)
    @SerializePaginated(newsResponseSchema)
    list(
        @Query() query: ListNewsQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<PaginatedResult<NewsEntity>> {
        return this.news.list(query, user);
    }

    @Get('rss')
    @Public()
    async rss(@Query() query: RssQueryDto, @Res() res: Response): Promise<void> {
        const items = await this.news.feed(query);
        const site = this.config.site.publicUrl;
        const xml = renderRss(
            {
                title: 'Smart City news',
                link: `${site}/news`,
                description: 'Latest news of the Smart City platform',
                itemLink: (item) =>
                    `${site}/organizations/${item.organization_id.toHexString()}/news/${item.slug ?? item._id.toHexString()}`,
            },
            items,
        );
        res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(xml);
    }

    @Get(':id')
    @Public()
    @ApiData(NewsResponseDto)
    @ApiErrors('NEWS_NOT_FOUND')
    @Serialize(newsResponseSchema)
    getOne(@Param('id') id: string, @CurrentUser() user?: AuthUser): Promise<NewsEntity> {
        return this.news.getById(id, user);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: NewsResponseDto })
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'NEWS_SLUG_TAKEN')
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
    @ApiErrors('NEWS_NOT_FOUND', 'NEWS_SLUG_TAKEN')
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
