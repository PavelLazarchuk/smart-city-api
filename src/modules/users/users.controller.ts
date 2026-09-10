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
    Put,
    Query,
    Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';
import { type ZodType } from 'zod';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { Serialize, SerializeList, SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { objectIdSchema } from '../../common/zod/primitives';
import {
    BookingRefResponseDto,
    bookingRefResponseSchema,
    CreateUserDto,
    ListUsersQueryDto,
    SetUserOrganizationsDto,
    updateSelfSchema,
    updateUserAdminSchema,
    UserResponseDto,
    userResponseSchema,
} from './dto/user.schemas';
import { type BookingRef } from './schemas/user.schema';
import { type UserEntity } from './users.repository';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
    constructor(private readonly users: UsersService) {}

    @Get()
    @Roles(ROLES.SUPER_ADMIN)
    @ApiPaginated(UserResponseDto)
    @SerializePaginated(userResponseSchema)
    list(@Query() query: ListUsersQueryDto): Promise<PaginatedResult<UserEntity>> {
        return this.users.list(query);
    }

    @Post()
    @Roles(ROLES.SUPER_ADMIN)
    @ApiCreatedResponse({ type: UserResponseDto })
    @Serialize(userResponseSchema)
    async create(
        @Body() body: CreateUserDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<UserEntity> {
        const user = await this.users.create(body);
        res.setHeader('Location', `/users/${user._id.toHexString()}`);

        return user;
    }

    @Get(':id')
    @ApiData(UserResponseDto)
    @Serialize(userResponseSchema)
    getOne(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<UserEntity> {
        this.assertSelfOrSuperAdmin(id, user);

        return this.users.getById(id);
    }

    @Patch(':id')
    @ApiData(UserResponseDto)
    @Serialize(userResponseSchema)
    update(
        @Param('id') id: string,
        @Body() body: unknown,
        @CurrentUser() user: AuthUser,
    ): Promise<UserEntity> {
        this.assertSelfOrSuperAdmin(id, user);

        if (user.role === ROLES.SUPER_ADMIN) {
            return this.users.updateByAdmin(id, this.parse(updateUserAdminSchema, body), user);
        }

        return this.users.updateSelf(id, this.parse(updateSelfSchema, body));
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
        this.assertSelfOrSuperAdmin(id, user);
        await this.users.delete(id);
    }

    @Put(':id/organizations')
    @Roles(ROLES.SUPER_ADMIN)
    @ApiData(UserResponseDto)
    @Serialize(userResponseSchema)
    setOrganizations(@Param('id') id: string, @Body() body: SetUserOrganizationsDto): Promise<UserEntity> {
        return this.users.setOrganizations(id, body.organization_ids);
    }

    @Get(':id/bookings')
    @ApiData(BookingRefResponseDto)
    @SerializeList(bookingRefResponseSchema)
    bookings(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<BookingRef[]> {
        this.assertSelfOrSuperAdmin(id, user);

        return this.users.getBookings(id);
    }

    private parse<T>(schema: ZodType<T>, body: unknown): T {
        const result = schema.safeParse(body);

        if (result.success) return result.data;

        throw ApiError.badRequest(
            'VALIDATION_ERROR',
            result.error.issues.map((issue) => ({
                path: issue.path.map(String).join('.'),
                message: issue.message,
                code: issue.code,
            })),
        );
    }

    private assertSelfOrSuperAdmin(id: string, user: AuthUser): void {
        if (!objectIdSchema.safeParse(id).success) throw ApiError.notFound('USER_NOT_FOUND');

        if (user.role === ROLES.SUPER_ADMIN || user.id === id) return;

        throw ApiError.forbidden('FORBIDDEN');
    }
}
