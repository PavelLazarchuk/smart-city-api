import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfig } from '../config/app-config';
import { TransactionRunner } from './transaction-runner';

/**
 * Mongoose connection. Indexes are created by migrations; `autoIndex` is off in production. Pool
 * size, retries, write concern and read preference are pinned here rather than left to driver
 * defaults, so a URI without options cannot quietly change the durability of every write.
 */
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
                writeConcern: { w: config.mongo.writeConcern === '1' ? 1 : 'majority' },
                readPreference: config.mongo.readPreference,
            }),
        }),
    ],
    providers: [TransactionRunner],
    exports: [MongooseModule, TransactionRunner],
})
export class DatabaseModule {}
