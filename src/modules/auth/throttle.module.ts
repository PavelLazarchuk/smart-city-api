import { Module } from '@nestjs/common';
import { type ExecutionContext } from '@nestjs/common';
import { ThrottlerModule, ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';

import { AppConfig } from '../../common/config/app-config';
import { SettingsService } from '../../common/settings/settings.service';
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
            inject: [AppConfig, SettingsService, MongoThrottlerStorage, RedisThrottlerStorage],
            useFactory: (
                config: AppConfig,
                settings: SettingsService,
                mongoStorage: MongoThrottlerStorage,
                redisStorage: RedisThrottlerStorage,
            ) => {
                const ttl = (): number => settings.get('throttle.ttl_seconds') * 1000;

                return {
                    storage: storageFor(config, mongoStorage, redisStorage),
                    throttlers: [
                        {
                            name: 'global',
                            ttl,
                            limit: () => settings.get('throttle.global_limit'),
                        },
                        {
                            name: 'auth',
                            ttl,
                            limit: () => settings.get('throttle.limit'),
                            skipIf: (context) => {
                                const path = pathOf(context);

                                return !path.includes('/auth/') && !path.endsWith('/me/phone/code');
                            },
                        },
                        {
                            name: 'phone',
                            ttl,
                            limit: () => settings.get('throttle.limit'),
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
                            ttl,
                            limit: () => settings.get('throttle.upload_limit'),
                            skipIf: (context) =>
                                !(methodOf(context) === 'POST' && pathOf(context).endsWith('/images')),
                        },
                    ],
                };
            },
        }),
    ],
    exports: [ThrottlerModule],
})
export class ThrottleModule {}
