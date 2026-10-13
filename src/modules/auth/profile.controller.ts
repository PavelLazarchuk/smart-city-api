import { Body, Controller, Delete, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiData } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { UserResponseDto, userResponseSchema } from '../users/dto/user.schemas';
import { type UserEntity } from '../users/users.repository';
import {
    DeleteAccountDto,
    OtpRequestResponseDto,
    otpRequestResponseSchema,
    PhoneCodeRequestDto,
    UpdateProfileDto,
} from './dto/auth.schemas';
import { ProfileService } from './profile.service';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('me')
export class ProfileController {
    constructor(private readonly profile: ProfileService) {}

    @Patch()
    @ApiData(UserResponseDto)
    @ApiErrors(
        'USER_NOT_FOUND',
        'PHONE_COUNTRY_NOT_SUPPORTED',
        'PHONE_CODE_REQUIRED',
        'PHONE_CODE_INVALID',
        'PHONE_TAKEN',
    )
    @Serialize(userResponseSchema)
    update(@Body() body: UpdateProfileDto, @CurrentUser() user: AuthUser): Promise<UserEntity> {
        return this.profile.update(user, body);
    }

    @Post('phone/code')
    @HttpCode(HttpStatus.OK)
    @ApiData(OtpRequestResponseDto)
    @ApiErrors('PHONE_COUNTRY_NOT_SUPPORTED')
    @Serialize(otpRequestResponseSchema)
    requestPhoneCode(
        @Body() body: PhoneCodeRequestDto,
        @CurrentUser() user: AuthUser,
    ): Promise<{ phone: string; expires_in: number }> {
        return this.profile.requestPhoneCode(user, body.phone);
    }

    @Post('deletion/code')
    @Roles(ROLES.COMMON_USER)
    @HttpCode(HttpStatus.OK)
    @ApiData(OtpRequestResponseDto)
    @Serialize(otpRequestResponseSchema)
    requestDeletionCode(@CurrentUser() user: AuthUser): Promise<{ phone: string; expires_in: number }> {
        return this.profile.requestDeletionCode(user);
    }

    @Delete()
    @Roles(ROLES.COMMON_USER)
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('DELETION_CODE_INVALID')
    async remove(@Body() body: DeleteAccountDto, @CurrentUser() user: AuthUser): Promise<void> {
        await this.profile.deleteAccount(user, body.code);
    }
}
