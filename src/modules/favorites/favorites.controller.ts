import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { SerializePaginated } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import {
    FavoriteParamsDto,
    FavoriteResponseDto,
    favoriteResponseSchema,
    ListFavoritesQueryDto,
} from './dto/favorite.schemas';
import { type FavoriteView, FavoritesService } from './favorites.service';

@ApiTags('favorites')
@ApiBearerAuth()
@Controller('me/favorites')
export class FavoritesController {
    constructor(private readonly favorites: FavoritesService) {}

    @Get()
    @ApiPaginated(FavoriteResponseDto)
    @SerializePaginated(favoriteResponseSchema)
    list(
        @Query() query: ListFavoritesQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<FavoriteView>> {
        return this.favorites.list(query, user);
    }

    @Put(':type/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('SERVICE_NOT_FOUND', 'ORGANIZATION_NOT_FOUND', 'FAVORITES_LIMIT_REACHED')
    async add(@Param() params: FavoriteParamsDto, @CurrentUser() user: AuthUser): Promise<void> {
        await this.favorites.add(params, user);
    }

    @Delete(':type/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param() params: FavoriteParamsDto, @CurrentUser() user: AuthUser): Promise<void> {
        await this.favorites.remove(params, user);
    }
}
