import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfig } from '../config/app-config';
import { TransactionRunner } from './transaction-runner';

/** Indexes come from migrations; pool, retries and write concern are pinned so a bare URI cannot change durability. */
@Global()
@Module({
    imports: [
        MongooseModule.forRootAsync({
            inject: [AppConfig],
            useFactory: (config: AppConfig) => ({
                uri: config.mongo.uri,
                autoIndex: config.mongo.autoIndex,
                autoCreate: config.mongo.autoIndex,
                serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
                socketTimeoutMS: config.mongo.socketTimeoutMs,
                maxPoolSize: config.mongo.maxPoolSize,
                minPoolSize: config.mongo.minPoolSize,
                retryWrites: config.mongo.retryWrites,
                retryReads: true,
                writeConcern: { w: config.mongo.writeConcern },
                readPreference: config.mongo.readPreference,
            }),
        }),
    ],
    providers: [TransactionRunner],
    exports: [MongooseModule, TransactionRunner],
})
export class DatabaseModule {}
