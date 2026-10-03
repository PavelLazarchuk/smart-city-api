import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { ChannelTemplatesController } from './channel-templates.controller';
import { ChannelTemplatesRepository } from './channel-templates.repository';
import { ChannelTemplatesService } from './channel-templates.service';
import { ChannelTemplate, ChannelTemplateSchema } from './schemas/channel-template.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: ChannelTemplate.name, schema: ChannelTemplateSchema }]),
        OrganizationsModule,
    ],
    controllers: [ChannelTemplatesController],
    providers: [ChannelTemplatesRepository, ChannelTemplatesService],
    exports: [ChannelTemplatesService],
})
export class ChannelTemplatesModule {}
