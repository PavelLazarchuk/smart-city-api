import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationTemplatesRepository } from './notification-templates.repository';
import { NotificationTemplatesService } from './notification-templates.service';
import { NotificationTemplate, NotificationTemplateSchema } from './schemas/notification-template.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: NotificationTemplate.name, schema: NotificationTemplateSchema }]),
        OrganizationsModule,
    ],
    controllers: [NotificationTemplatesController],
    providers: [NotificationTemplatesRepository, NotificationTemplatesService],
    exports: [NotificationTemplatesService],
})
export class NotificationTemplatesModule {}
