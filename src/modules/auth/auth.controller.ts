import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { ApiData } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { EVENT_TYPES, TrackEvent } from '../../common/decorators/track-event.decorator';
import { Serialize, SerializeList } from '../../common/http/serialize.decorator';
import { UserResponseDto, userResponseSchema } from '../users/dto/user.schemas';
import { type UserEntity } from '../users/users.repository';
import { type ClientInfo, AuthService } from './auth.service';
import {
    ChangePasswordDto,
    LoginDto,
    OtpRequestDto,
    OtpRequestResponseDto,
    otpRequestResponseSchema,
    OtpVerifyDto,
    RefreshDto,
    RegisterDto,
    type SessionResponse,
    SessionResponseDto,
    sessionResponseSchema,
    TokenPairResponseDto,
    type TokenPairResponse,
    tokenPairResponseSchema,
} from './dto/auth.schemas';

function clientInfo(req: Request): ClientInfo {
    return { user_agent: req.headers['user-agent']?.slice(0, 512), ip: req.ip };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly auth: AuthService) {}

    @Post('login')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiData(TokenPairResponseDto)
    @Serialize(tokenPairResponseSchema)
    login(@Body() body: LoginDto, @Req() req: Request): Promise<TokenPairResponse> {
        return this.auth.login(body, clientInfo(req));
    }

    @Post('register')
    @Public()
    @ApiCreatedResponse({ type: TokenPairResponseDto })
    @Serialize(tokenPairResponseSchema)
    register(@Body() body: RegisterDto, @Req() req: Request): Promise<TokenPairResponse> {
        return this.auth.register(body, clientInfo(req));
    }

    @Post('otp/request')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiData(OtpRequestResponseDto)
    @Serialize(otpRequestResponseSchema)
    @TrackEvent(EVENT_TYPES.OTP_REQUESTED)
    requestOtp(@Body() body: OtpRequestDto): Promise<{ phone: string; expires_in: number }> {
        return this.auth.requestOtp(body.phone);
    }

    @Post('otp/verify')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiData(TokenPairResponseDto)
    @Serialize(tokenPairResponseSchema)
    @TrackEvent(EVENT_TYPES.OTP_VERIFIED, (result) => {
        const user = (result as TokenPairResponse).user;

        return { user_id: user.id, user_role: user.role };
    })
    verifyOtp(@Body() body: OtpVerifyDto, @Req() req: Request): Promise<TokenPairResponse> {
        return this.auth.verifyOtp(body, clientInfo(req));
    }

    @Post('refresh')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiData(TokenPairResponseDto)
    @Serialize(tokenPairResponseSchema)
    refresh(@Body() body: RefreshDto, @Req() req: Request): Promise<TokenPairResponse> {
        return this.auth.refresh(body.refresh_token, clientInfo(req));
    }

    @Get('sessions')
    @ApiBearerAuth()
    @ApiData(SessionResponseDto)
    @SerializeList(sessionResponseSchema)
    sessions(@CurrentUser() user: AuthUser): Promise<SessionResponse[]> {
        return this.auth.listSessions(user);
    }

    @Delete('sessions/:sid')
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiNoContentResponse({ description: 'Session revoked' })
    async revokeSession(@CurrentUser() user: AuthUser, @Param('sid') sid: string): Promise<void> {
        await this.auth.revokeSession(user, sid);
    }

    @Post('logout')
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    async logout(@CurrentUser() user: AuthUser): Promise<void> {
        await this.auth.logout(user);
    }

    @Post('logout-all')
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    async logoutAll(@CurrentUser() user: AuthUser): Promise<void> {
        await this.auth.logoutAll(user);
    }

    @Get('me')
    @ApiBearerAuth()
    @ApiData(UserResponseDto)
    @Serialize(userResponseSchema)
    me(@CurrentUser() user: AuthUser): Promise<UserEntity> {
        return this.auth.me(user);
    }

    @Patch('password')
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiNoContentResponse({ description: 'Password changed' })
    async changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto): Promise<void> {
        await this.auth.changePassword(user, body.current_password, body.new_password);
    }
}
