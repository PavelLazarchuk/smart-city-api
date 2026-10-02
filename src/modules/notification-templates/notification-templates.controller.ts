import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiData } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { ADMIN_ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializeList } from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import {
    type NotificationTemplateResource,
    NotificationTemplateResourceDto,
    notificationTemplateResourceSchema,
    PreviewNotificationTemplateDto,
    type RenderedNotification,
    RenderedNotificationDto,
    renderedNotificationSchema,
    SaveNotificationTemplateDto,
} from './dto/notification-template.schemas';
import { NotificationTemplatesService } from './notification-templates.service';

@ApiTags('notification-templates')
@ApiBearerAuth()
@Controller('organizations/:id/notification-templates')
@Roles(...ADMIN_ROLES)
export class NotificationTemplatesController {
    constructor(private readonly templates: NotificationTemplatesService) {}

    @Get()
    @OrganizationScope({ from: 'path' })
    @ApiData(NotificationTemplateResourceDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND')
    @SerializeList(notificationTemplateResourceSchema)
    list(@Param('id') id: string): Promise<NotificationTemplateResource[]> {
        return this.templates.list(id);
    }

    @Get(':key')
    @OrganizationScope({ from: 'path' })
    @ApiData(NotificationTemplateResourceDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'NOTIFICATION_TEMPLATE_NOT_FOUND')
    @Serialize(notificationTemplateResourceSchema)
    getOne(@Param('id') id: string, @Param('key') key: string): Promise<NotificationTemplateResource> {
        return this.templates.get(id, key);
    }

    @Put(':key')
    @OrganizationScope({ from: 'path' })
    @ApiData(NotificationTemplateResourceDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'NOTIFICATION_TEMPLATE_NOT_FOUND')
    @Serialize(notificationTemplateResourceSchema)
    save(
        @Param('id') id: string,
        @Param('key') key: string,
        @Body() body: SaveNotificationTemplateDto,
        @CurrentUser() user: AuthUser,
    ): Promise<NotificationTemplateResource> {
        return this.templates.save(id, key, body, user);
    }

    @Delete(':key')
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'NOTIFICATION_TEMPLATE_NOT_FOUND')
    async reset(@Param('id') id: string, @Param('key') key: string): Promise<void> {
        await this.templates.reset(id, key);
    }

    @Post(':key/preview')
    @OrganizationScope({ from: 'path' })
    @HttpCode(HttpStatus.OK)
    @ApiData(RenderedNotificationDto)
    @ApiErrors('ORGANIZATION_NOT_FOUND', 'NOTIFICATION_TEMPLATE_NOT_FOUND')
    @Serialize(renderedNotificationSchema)
    preview(
        @Param('id') id: string,
        @Param('key') key: string,
        @Body() body: PreviewNotificationTemplateDto,
    ): Promise<RenderedNotification> {
        return this.templates.preview(id, key, body);
    }
}
