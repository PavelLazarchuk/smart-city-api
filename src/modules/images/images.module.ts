import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';

import { AppConfig } from '../../common/config/app-config';
import { ApiError } from '../../common/http/api-error';
import { StorageModule } from '../../integrations/storage/storage.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ImagesController } from './images.controller';
import { ImagesRepository } from './images.repository';
import { ImagesService } from './images.service';
import { Image, ImageSchema } from './schemas/image.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Image.name, schema: ImageSchema }]),
        /**
         * `BODY_LIMIT` never reaches multipart, so the cap is multer's own and applies while the stream is read.
         * The magic-byte check in the service still has the final word on the type.
         */
        MulterModule.registerAsync({
            inject: [AppConfig],
            useFactory: (config: AppConfig) => ({
                limits: { fileSize: config.upload.maxBytes, files: 1, fields: 8 },
                fileFilter: (
                    _request: unknown,
                    file: { mimetype: string },
                    callback: (error: Error | null, acceptFile: boolean) => void,
                ) => {
                    const allowed = config.upload.allowedMime.includes(file.mimetype);
                    callback(allowed ? null : ApiError.badRequest('FILE_TYPE_NOT_ALLOWED'), allowed);
                },
            }),
        }),
        StorageModule,
        OrganizationsModule,
    ],
    controllers: [ImagesController],
    providers: [ImagesRepository, ImagesService],
    exports: [ImagesService, ImagesRepository],
})
export class ImagesModule {}
