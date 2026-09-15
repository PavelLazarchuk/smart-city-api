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
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { EVENT_TYPES, TrackEvent } from '../../common/decorators/track-event.decorator';
import {
    Serialize,
    SerializeBy,
    SerializeList,
    SerializePaginated,
} from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto';
import { CategoriesService } from '../categories/categories.service';
import { CategoryResponseDto, categoryResponseSchema } from '../categories/dto/category.schemas';
import { ImageResponseDto, imageResponseSchema } from '../images/dto/image.schemas';
import { ImagesService } from '../images/images.service';
import { InfoSectionResponseDto, infoSectionResponseSchema } from '../infosections/dto/infosection.schemas';
import { InfoSectionsService } from '../infosections/infosections.service';
import { NewsResponseDto, newsResponseSchema } from '../news/dto/news.schemas';
import { type NewsEntity } from '../news/news.repository';
import { NewsService } from '../news/news.service';
import {
    GetServiceQueryDto,
    MaskedServiceResponseDto,
    maskedServiceResponseSchema,
    serviceSchemaForViewer,
} from '../services/dto/service.schemas';
import { ServicesService } from '../services/services.service';
import {
    CreateOrganizationDto,
    ListOrganizationsQueryDto,
    MaskedOrganizationListItemDto,
    maskedOrganizationListItemSchema,
    NearbyOrganizationsQueryDto,
    OrganizationDetailDto,
    organizationDetailSchema,
    organizationListSchemaForViewer,
    OrganizationResponseDto,
    organizationResponseSchema,
    ReorderDto,
    UpdateOrganizationDto,
} from './dto/organization.schemas';
import { type OrganizationEntity, type OrganizationListRow } from './organizations.repository';
import { type OrganizationTree, OrganizationsService } from './organizations.service';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
    constructor(
        private readonly organizations: OrganizationsService,
        private readonly news: NewsService,
        private readonly infosections: InfoSectionsService,
        private readonly categories: CategoriesService,
        private readonly services: ServicesService,
        private readonly images: ImagesService,
    ) {}

    @Get()
    @Public()
    @ApiPaginated(MaskedOrganizationListItemDto)
    @SerializeBy(organizationListSchemaForViewer, maskedOrganizationListItemSchema, 'paginated')
    @TrackEvent(EVENT_TYPES.ORGANIZATIONS_LISTED)
    list(
        @Query() query: ListOrganizationsQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<PaginatedResult<OrganizationListRow>> {
        return this.organizations.list(query, user);
    }

    @Get('nearby')
    @Public()
    @ApiData(OrganizationResponseDto)
    @SerializeList(organizationResponseSchema)
    nearby(@Query() query: NearbyOrganizationsQueryDto): Promise<OrganizationEntity[]> {
        return this.organizations.nearby(query);
    }

    @Post()
    @Roles(ROLES.SUPER_ADMIN)
    @ApiBearerAuth()
    @ApiCreatedResponse({ type: OrganizationResponseDto })
    @Serialize(organizationResponseSchema)
    async create(
        @Body() body: CreateOrganizationDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<OrganizationEntity> {
        const organization = await this.organizations.create(body);
        res.setHeader('Location', `/organizations/${organization._id.toHexString()}`);

        return organization;
    }

    @Get(':id')
    @Public()
    @ApiData(OrganizationDetailDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND')
    @Serialize(organizationDetailSchema)
    @TrackEvent(EVENT_TYPES.ORGANIZATION_VIEWED, (result) => {
        const tree = result as OrganizationTree;

        return { organization_id: tree._id.toHexString(), organization_label: tree.main_label };
    })
    getOne(@Param('id') id: string): Promise<OrganizationTree> {
        return this.organizations.getTree(id);
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'path' })
    @ApiData(OrganizationResponseDto)
    @Serialize(organizationResponseSchema)
    update(@Param('id') id: string, @Body() body: UpdateOrganizationDto): Promise<OrganizationEntity> {
        return this.organizations.update(id, body);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.SUPER_ADMIN)
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.organizations.delete(id);
    }

    @Get(':id/news')
    @Public()
    @ApiPaginated(NewsResponseDto)
    @SerializePaginated(newsResponseSchema)
    async listNews(
        @Param('id') id: string,
        @Query() query: PaginationQueryDto,
    ): Promise<PaginatedResult<unknown>> {
        await this.organizations.assertExists(id);

        return this.news.list({ ...query, organization_id: id });
    }

    @Get(':id/infosections')
    @Public()
    @ApiPaginated(InfoSectionResponseDto)
    @SerializePaginated(infoSectionResponseSchema)
    async listInfoSections(
        @Param('id') id: string,
        @Query() query: PaginationQueryDto,
    ): Promise<PaginatedResult<unknown>> {
        await this.organizations.assertExists(id);

        return this.infosections.list({ ...query, organization_id: id });
    }

    @Get(':id/categories')
    @Public()
    @ApiPaginated(CategoryResponseDto)
    @SerializePaginated(categoryResponseSchema)
    async listCategories(
        @Param('id') id: string,
        @Query() query: PaginationQueryDto,
    ): Promise<PaginatedResult<unknown>> {
        await this.organizations.assertExists(id);

        return this.categories.list({ ...query, organization_id: id });
    }

    @Get(':id/services')
    @Public()
    @ApiPaginated(MaskedServiceResponseDto)
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema, 'paginated')
    async listServices(
        @Param('id') id: string,
        @Query() query: PaginationQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<PaginatedResult<unknown>> {
        await this.organizations.assertExists(id);

        return this.services.list({ ...query, organization_id: id, tags: [], include: [] }, user);
    }

    @Get(':id/services/:slug')
    @Public()
    @ApiData(MaskedServiceResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema)
    serviceBySlug(
        @Param('id') id: string,
        @Param('slug') slug: string,
        @Query() query: GetServiceQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<unknown> {
        return this.services.getBySlug(id, slug, user, query);
    }

    @Get(':id/news/:slug')
    @Public()
    @ApiData(NewsResponseDto)
    @ApiErrors('NEWS_NOT_FOUND')
    @Serialize(newsResponseSchema)
    newsBySlug(
        @Param('id') id: string,
        @Param('slug') slug: string,
        @CurrentUser() user?: AuthUser,
    ): Promise<NewsEntity> {
        return this.news.getBySlug(id, slug, user);
    }

    @Get(':id/images')
    @Public()
    @ApiPaginated(ImageResponseDto)
    @SerializePaginated(imageResponseSchema)
    async listImages(
        @Param('id') id: string,
        @Query() query: PaginationQueryDto,
    ): Promise<PaginatedResult<unknown>> {
        await this.organizations.assertExists(id);

        return this.images.listByOrganization(id, query);
    }

    @Patch(':id/news/order')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async reorderNews(@Param('id') id: string, @Body() body: ReorderDto): Promise<void> {
        await this.organizations.assertExists(id);
        await this.news.reorder(id, body.ids);
    }

    @Patch(':id/infosections/order')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async reorderInfoSections(@Param('id') id: string, @Body() body: ReorderDto): Promise<void> {
        await this.organizations.assertExists(id);
        await this.infosections.reorder(id, body.ids);
    }

    @Patch(':id/categories/order')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async reorderCategories(@Param('id') id: string, @Body() body: ReorderDto): Promise<void> {
        await this.organizations.assertExists(id);
        await this.categories.reorder(id, body.ids);
    }

    /** Reorders only the organization's direct (uncategorized) services. */
    @Patch(':id/services/order')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async reorderServices(@Param('id') id: string, @Body() body: ReorderDto): Promise<void> {
        await this.organizations.assertExists(id);
        await this.services.reorderDirect(id, body.ids);
    }
}
