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
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto';
import {
    CreateOperatorDto,
    UpdateOperatorDto,
    UserResponseDto,
    userResponseSchema,
} from './dto/user.schemas';
import { type UserEntity } from './users.repository';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('organizations/:id/operators')
@Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
export class OrganizationOperatorsController {
    constructor(private readonly users: UsersService) {}

    @Get()
    @OrganizationScope({ from: 'path' })
    @ApiPaginated(UserResponseDto)
    @SerializePaginated(userResponseSchema)
    list(@Param('id') id: string, @Query() query: PaginationQueryDto): Promise<PaginatedResult<UserEntity>> {
        return this.users.listOperators(id, query);
    }

    @Post()
    @OrganizationScope({ from: 'path' })
    @ApiCreatedResponse({ type: UserResponseDto })
    @ApiErrors('ADMIN_PASSWORD_REQUIRED', 'ADMIN_PHONE_REQUIRED', 'LOGIN_TAKEN', 'PHONE_TAKEN')
    @Serialize(userResponseSchema)
    create(
        @Param('id') id: string,
        @Body() body: CreateOperatorDto,
        @CurrentUser() user: AuthUser,
    ): Promise<UserEntity> {
        return this.users.createOperator(id, body, user);
    }

    @Patch(':user_id')
    @OrganizationScope({ from: 'path' })
    @ApiData(UserResponseDto)
    @ApiErrors('USER_NOT_FOUND', 'LOGIN_TAKEN', 'PHONE_TAKEN')
    @Serialize(userResponseSchema)
    update(
        @Param('id') id: string,
        @Param('user_id') userId: string,
        @Body() body: UpdateOperatorDto,
        @CurrentUser() user: AuthUser,
    ): Promise<UserEntity> {
        return this.users.updateOperator(id, userId, body, user);
    }

    @Delete(':user_id')
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('USER_NOT_FOUND')
    async remove(@Param('id') id: string, @Param('user_id') userId: string): Promise<void> {
        await this.users.removeOperator(id, userId);
    }
}
