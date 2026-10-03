import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiData } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { ADMIN_ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializeList } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import {
    type ChannelTemplateResource,
    ChannelTemplateResourceDto,
    channelTemplateResourceSchema,
    PreviewChannelTemplateDto,
    type RenderedTemplate,
    RenderedTemplateDto,
    renderedTemplateSchema,
    SaveChannelTemplateDto,
} from './dto/channel-template.schemas';
import { ChannelTemplatesService } from './channel-templates.service';

@ApiTags('channel-templates')
@ApiBearerAuth()
@Controller('organizations/:id/channel-templates')
@Roles(...ADMIN_ROLES)
export class ChannelTemplatesController {
    constructor(private readonly templates: ChannelTemplatesService) {}

    @Get()
    @OrganizationScope({ from: 'path' })
    @ApiData(ChannelTemplateResourceDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND')
    @SerializeList(channelTemplateResourceSchema)
    list(@Param('id') id: string): Promise<ChannelTemplateResource[]> {
        return this.templates.list(id);
    }

    @Get(':key')
    @OrganizationScope({ from: 'path' })
    @ApiData(ChannelTemplateResourceDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'CHANNEL_TEMPLATE_NOT_FOUND')
    @Serialize(channelTemplateResourceSchema)
    getOne(@Param('id') id: string, @Param('key') key: string): Promise<ChannelTemplateResource> {
        return this.templates.get(id, key);
    }

    @Put(':key')
    @OrganizationScope({ from: 'path' })
    @ApiData(ChannelTemplateResourceDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'CHANNEL_TEMPLATE_NOT_FOUND')
    @Serialize(channelTemplateResourceSchema)
    save(
        @Param('id') id: string,
        @Param('key') key: string,
        @Body() body: SaveChannelTemplateDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ChannelTemplateResource> {
        return this.templates.save(id, key, body, user);
    }

    @Delete(':key')
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'CHANNEL_TEMPLATE_NOT_FOUND')
    async reset(@Param('id') id: string, @Param('key') key: string): Promise<void> {
        await this.templates.reset(id, key);
    }

    @Post(':key/preview')
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.OK)
    @ApiData(RenderedTemplateDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'CHANNEL_TEMPLATE_NOT_FOUND')
    @Serialize(renderedTemplateSchema)
    preview(
        @Param('id') id: string,
        @Param('key') key: string,
        @Body() body: PreviewChannelTemplateDto,
    ): Promise<RenderedTemplate> {
        return this.templates.preview(id, key, body);
    }
}
