import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { REDIS_CONNECTION } from '../../common/config/constants';

interface ThrottlerStorageRecord {
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
}

interface ThrottlerRedis extends Redis {
    throttle(
        hitsKey: string,
        blockKey: string,
        ttl: number,
        limit: number,
        blockDuration: number,
    ): Promise<[number, number, number]>;
}

const SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', blockKey)
local hits = redis.call('INCR', hitsKey)
local windowTtl = redis.call('PTTL', hitsKey)

if windowTtl < 0 then
    redis.call('PEXPIRE', hitsKey, ttl)
    windowTtl = ttl
end

if blockTtl <= 0 and hits > limit then
    redis.call('SET', blockKey, '1', 'PX', blockDuration)
    blockTtl = blockDuration
end

if blockTtl < 0 then
    blockTtl = 0
end

return { hits, windowTtl, blockTtl }
`;

function redisTarget(url: string): string {
    try {
        const parsed = new URL(url);

        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
        return 'unparsable';
    }
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
    private readonly client: ThrottlerRedis;
    private readonly fallback = new ThrottlerStorageService();
    private degraded = false;

    constructor(
        private readonly config: AppConfig,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(RedisThrottlerStorage.name);
        this.client = new Redis(config.redis.url, {
            keyPrefix: config.redis.keyPrefix,
            lazyConnect: true,
            enableOfflineQueue: false,
            connectTimeout: REDIS_CONNECTION.connectTimeoutMs,
            commandTimeout: REDIS_CONNECTION.commandTimeoutMs,
            maxRetriesPerRequest: REDIS_CONNECTION.maxRetriesPerRequest,
        }) as ThrottlerRedis;
        this.client.defineCommand('throttle', { numberOfKeys: 2, lua: SCRIPT });
        this.client.on('error', (error: Error) => this.report(error));
    }

    async increment(
        key: string,
        ttl: number,
        limit: number,
        blockDuration: number,
        throttlerName: string,
    ): Promise<ThrottlerStorageRecord> {
        try {
            const [hits, windowTtl, blockTtl] = await this.client.throttle(
                `${throttlerName}:${key}`,
                `${throttlerName}:${key}:blocked`,
                ttl,
                limit,
                Math.max(blockDuration, ttl),
            );

            if (this.degraded) {
                this.degraded = false;
                this.logger.info('redis throttler storage recovered');
            }

            return {
                totalHits: hits,
                timeToExpire: Math.ceil(windowTtl / 1000),
                isBlocked: blockTtl > 0,
                timeToBlockExpire: Math.ceil(blockTtl / 1000),
            };
        } catch (error) {
            this.report(error);

            return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
        }
    }

    async onApplicationShutdown(): Promise<void> {
        this.fallback.onApplicationShutdown();

        if (this.client.status === 'ready') await this.client.quit();
        else this.client.disconnect();
    }

    private report(error: unknown): void {
        if (this.degraded) return;

        this.degraded = true;
        this.logger.error(
            { err: error, redis: redisTarget(this.config.redis.url) },
            'redis throttler storage unavailable, throttling per instance until it recovers',
        );
    }
}
