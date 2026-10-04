import { Body, Controller, Delete, Get, Headers, Param, Patch, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData } from '../decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../decorators/current-user.decorator';
import { Roles, ROLES } from '../decorators/roles.decorator';
import { Serialize } from '../http/serialize.decorator';
import { ApiErrors } from '../openapi/api-errors.decorator';
import {
    type SettingResource,
    SettingResourceDto,
    settingResourceSchema,
    type SettingsResource,
    SettingsResourceDto,
    settingsResourceSchema,
    UpdateSettingsDto,
} from './dto/settings.schemas';
import { SettingsService } from './settings.service';

const IF_MATCH = { name: 'If-Match', required: false, description: 'ETag from GET /settings' };

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
@Roles(ROLES.SUPER_ADMIN)
export class SettingsController {
    constructor(private readonly settings: SettingsService) {}

    @Get()
    @ApiData(SettingsResourceDto)
    @Serialize(settingsResourceSchema)
    list(@Res({ passthrough: true }) res: Response): SettingsResource {
        res.setHeader('ETag', this.settings.tag);

        return this.settings.list();
    }

    @Get(':key')
    @ApiData(SettingResourceDto)
    @ApiErrors('SETTING_NOT_FOUND')
    @Serialize(settingResourceSchema)
    getOne(@Param('key') key: string, @Res({ passthrough: true }) res: Response): SettingResource {
        res.setHeader('ETag', this.settings.tag);

        return this.settings.getOne(key);
    }

    @Patch()
    @ApiHeader(IF_MATCH)
    @ApiData(SettingsResourceDto)
    @ApiErrors('SETTINGS_INVALID', 'SETTING_LOCKOUT_RISK', 'SETTINGS_READ_ONLY', 'SETTINGS_CONFLICT')
    @Serialize(settingsResourceSchema)
    async update(
        @Body() body: UpdateSettingsDto,
        @Headers('if-match') ifMatch: string | undefined,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<SettingsResource> {
        const result = await this.settings.update(body.values, ifMatch, user);
        res.setHeader('ETag', this.settings.tag);

        return result;
    }

    @Delete(':key')
    @ApiHeader(IF_MATCH)
    @ApiData(SettingsResourceDto)
    @ApiErrors(
        'SETTING_NOT_FOUND',
        'SETTINGS_INVALID',
        'SETTING_LOCKOUT_RISK',
        'SETTINGS_READ_ONLY',
        'SETTINGS_CONFLICT',
    )
    @Serialize(settingsResourceSchema)
    async reset(
        @Param('key') key: string,
        @Headers('if-match') ifMatch: string | undefined,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<SettingsResource> {
        const result = await this.settings.reset(key, ifMatch, user);
        res.setHeader('ETag', this.settings.tag);

        return result;
    }
}
