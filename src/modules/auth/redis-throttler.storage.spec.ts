import { type PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { validateEnv } from '../../common/config/env.schema';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const config = new AppConfig(
    validateEnv({
        MONGO_URI: 'mongodb://localhost/x',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        THROTTLE_STORAGE: 'redis',
        REDIS_URL: 'redis://127.0.0.1:6379',
    }),
);

function build(): {
    storage: RedisThrottlerStorage;
    throttle: jest.Mock;
    logger: { error: jest.Mock; info: jest.Mock };
} {
    const logger = { setContext: jest.fn(), error: jest.fn(), info: jest.fn() };
    const storage = new RedisThrottlerStorage(config, logger as unknown as PinoLogger);
    const throttle = jest.fn();
    (storage as unknown as { client: { throttle: jest.Mock } }).client.throttle = throttle;

    return { storage, throttle, logger };
}

describe('RedisThrottlerStorage', () => {
    it('reports the window in seconds and blocks only while the block key lives', async () => {
        const { storage, throttle } = build();
        throttle.mockResolvedValue([3, 41_200, 0]);

        await expect(storage.increment('ip:1', 60_000, 10, 60_000, 'global')).resolves.toEqual({
            totalHits: 3,
            timeToExpire: 42,
            isBlocked: false,
            timeToBlockExpire: 0,
        });

        throttle.mockResolvedValue([11, 9000, 9000]);

        await expect(storage.increment('ip:1', 60_000, 10, 60_000, 'global')).resolves.toEqual({
            totalHits: 11,
            timeToExpire: 9,
            isBlocked: true,
            timeToBlockExpire: 9,
        });
    });

    it('namespaces the keys per throttler and never blocks for less than one window', async () => {
        const { storage, throttle } = build();
        throttle.mockResolvedValue([1, 60_000, 0]);
        await storage.increment('ip:1', 60_000, 10, 1000, 'auth');

        expect(throttle).toHaveBeenCalledWith('auth:ip:1', 'auth:ip:1:blocked', 60_000, 10, 60_000);
    });

    it('lets the request through when redis is down and logs the outage once', async () => {
        const { storage, throttle, logger } = build();
        throttle.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(storage.increment('ip:1', 60_000, 10, 60_000, 'global')).resolves.toEqual({
            totalHits: 0,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
        });
        await storage.increment('ip:1', 60_000, 10, 60_000, 'global');

        expect(logger.error).toHaveBeenCalledTimes(1);

        throttle.mockResolvedValue([1, 60_000, 0]);
        await storage.increment('ip:1', 60_000, 10, 60_000, 'global');

        expect(logger.info).toHaveBeenCalledWith('redis throttler storage recovered');
    });

    afterAll(() => jest.clearAllMocks());
});
