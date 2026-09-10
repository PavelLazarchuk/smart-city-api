import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfig } from '../config/app-config';
import { TransactionRunner } from './transaction-runner';

/** Mongoose connection. Indexes are created by migrations; `autoIndex` is off in production. */
@Global()
@Module({
    imports: [
        MongooseModule.forRootAsync({
            inject: [AppConfig],
            useFactory: (config: AppConfig) => ({
                uri: config.mongo.uri,
                autoIndex: config.mongo.autoIndex,
                autoCreate: config.mongo.autoIndex,
                serverSelectionTimeoutMS: 10_000,
            }),
        }),
    ],
    providers: [TransactionRunner],
    exports: [MongooseModule, TransactionRunner],
})
export class DatabaseModule {}
