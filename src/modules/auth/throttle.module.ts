import { Module } from '@nestjs/common';
import { type ExecutionContext } from '@nestjs/common';
import { ThrottlerModule, ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';

import { AppConfig } from '../../common/config/app-config';
import { MongoThrottlerStorage } from './mongo-throttler.storage';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { AuthStoreModule } from './store/auth-store.module';

function pathOf(context: ExecutionContext): string {
    if (context.getType() !== 'http') return '';

    const request = context.switchToHttp().getRequest<{ path?: string; url?: string }>();

    return request.path ?? request.url ?? '';
}

function methodOf(context: ExecutionContext): string {
    if (context.getType() !== 'http') return '';

    return context.switchToHttp().getRequest<{ method?: string }>().method ?? '';
}

function storageFor(
    config: AppConfig,
    mongo: MongoThrottlerStorage,
    redis: RedisThrottlerStorage,
): ThrottlerStorage {
    switch (config.throttle.storage) {
        case 'mongo':
            return mongo;
        case 'redis':
            return redis;
        default:
            return new ThrottlerStorageService();
    }
}

@Module({
    imports: [
        ThrottlerModule.forRootAsync({
            imports: [AuthStoreModule],
            inject: [AppConfig, MongoThrottlerStorage, RedisThrottlerStorage],
            useFactory: (
                config: AppConfig,
                mongoStorage: MongoThrottlerStorage,
                redisStorage: RedisThrottlerStorage,
            ) => ({
                storage: storageFor(config, mongoStorage, redisStorage),
                throttlers: [
                    {
                        name: 'global',
                        ttl: config.throttle.ttlSeconds * 1000,
                        limit: config.throttle.globalLimit,
                    },
                    {
                        name: 'auth',
                        ttl: config.throttle.ttlSeconds * 1000,
                        limit: config.throttle.limit,
                        skipIf: (context) => !pathOf(context).includes('/auth/'),
                    },
                    {
                        name: 'phone',
                        ttl: config.throttle.ttlSeconds * 1000,
                        limit: config.throttle.limit,
                        skipIf: (context) => {
                            const body = context
                                .switchToHttp()
                                .getRequest<{ body?: { phone?: unknown } }>().body;

                            return typeof body?.phone !== 'string';
                        },
                        getTracker: (req: Record<string, unknown>) => {
                            const body = req['body'] as { phone?: string } | undefined;

                            return `phone:${body?.phone ?? ''}`;
                        },
                    },
                    {
                        name: 'upload',
                        ttl: config.throttle.ttlSeconds * 1000,
                        limit: config.throttle.uploadLimit,
                        skipIf: (context) =>
                            !(methodOf(context) === 'POST' && pathOf(context).endsWith('/images')),
                    },
                ],
            }),
        }),
    ],
    exports: [ThrottlerModule],
})
export class ThrottleModule {}
