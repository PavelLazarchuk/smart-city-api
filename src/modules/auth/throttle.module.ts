import { Module } from '@nestjs/common';
import { type ExecutionContext } from '@nestjs/common';
import { ThrottlerModule, ThrottlerStorageService } from '@nestjs/throttler';

import { AppConfig } from '../../common/config/app-config';
import { MongoThrottlerStorage } from './mongo-throttler.storage';
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

@Module({
    imports: [
        ThrottlerModule.forRootAsync({
            imports: [AuthStoreModule],
            inject: [AppConfig, MongoThrottlerStorage],
            useFactory: (config: AppConfig, mongoStorage: MongoThrottlerStorage) => ({
                storage: config.throttle.storage === 'mongo' ? mongoStorage : new ThrottlerStorageService(),
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
