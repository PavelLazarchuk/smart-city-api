import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';

import { AppConfig } from '../../common/config/app-config';
import { StorageModule } from '../../integrations/storage/storage.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ImagesController } from './images.controller';
import { ImagesRepository } from './images.repository';
import { ImagesService } from './images.service';
import { Image, ImageSchema } from './schemas/image.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Image.name, schema: ImageSchema }]),
        MulterModule.registerAsync({
            inject: [AppConfig],
            useFactory: (config: AppConfig) => ({ limits: { fileSize: config.upload.maxBytes, files: 1 } }),
        }),
        StorageModule,
        OrganizationsModule,
    ],
    controllers: [ImagesController],
    providers: [ImagesRepository, ImagesService],
    exports: [ImagesService],
})
export class ImagesModule {}
