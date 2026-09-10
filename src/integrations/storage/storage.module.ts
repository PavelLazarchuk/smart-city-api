import { Module } from '@nestjs/common';

import { AppConfig } from '../../common/config/app-config';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER } from './storage.provider';

@Module({
    providers: [
        LocalStorageProvider,
        S3StorageProvider,
        {
            provide: STORAGE_PROVIDER,
            inject: [AppConfig, LocalStorageProvider, S3StorageProvider],
            useFactory: (config: AppConfig, local: LocalStorageProvider, s3: S3StorageProvider) =>
                config.storage.provider === 's3' ? s3 : local,
        },
    ],
    exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
