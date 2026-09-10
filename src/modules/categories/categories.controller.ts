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
import { ReorderDto } from '../organizations/dto/organization.schemas';
import { ServicesService } from '../services/services.service';
import { type CategoryEntity } from './categories.repository';
import { CategoriesService } from './categories.service';
import {
    CategoryResponseDto,
    categoryResponseSchema,
    CreateCategoryDto,
    ListCategoriesQueryDto,
    UpdateCategoryDto,
} from './dto/category.schemas';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
    constructor(
        private readonly categories: CategoriesService,
        private readonly services: ServicesService,
    ) {}

    @Get()
    @Public()
    @ApiPaginated(CategoryResponseDto)
    @SerializePaginated(categoryResponseSchema)
    list(@Query() query: ListCategoriesQueryDto): Promise<PaginatedResult<CategoryEntity>> {
        return this.categories.list(query);
    }

    @Get(':id')
    @Public()
    @ApiData(CategoryResponseDto)
    @Serialize(categoryResponseSchema)
    getOne(@Param('id') id: string): Promise<CategoryEntity> {
        return this.categories.getById(id);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: CategoryResponseDto })
    @Serialize(categoryResponseSchema)
    async create(
        @Body() body: CreateCategoryDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<CategoryEntity> {
        const category = await this.categories.create(body);
        res.setHeader('Location', `/categories/${category._id.toHexString()}`);

        return category;
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'category' })
    @ApiData(CategoryResponseDto)
    @Serialize(categoryResponseSchema)
    update(@Param('id') id: string, @Body() body: UpdateCategoryDto): Promise<CategoryEntity> {
        return this.categories.update(id, body);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'category' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.categories.delete(id);
    }

    @Patch(':id/services/order')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'category' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async reorderServices(@Param('id') id: string, @Body() body: ReorderDto): Promise<void> {
        await this.services.reorderInCategory(id, body.ids);
    }
}
