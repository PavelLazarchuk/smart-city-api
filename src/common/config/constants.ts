export const HTTP_BODY_LIMIT = '1mb';

export const MONGO_CONNECTION = {
    minPoolSize: 0,
    retryWrites: true,
    writeConcern: 'majority',
    readPreference: 'primary',
} as const;

export const REDIS_CONNECTION = {
    defaultUrl: 'redis://127.0.0.1:6379',
    keyPrefix: 'throttle:',
    connectTimeoutMs: 3000,
    commandTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
} as const;

export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const ARGON2_TEST_PARAMS = { memoryCost: 4096, timeCost: 1, parallelism: 1 } as const;

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

export const PAGINATION = {
    defaultLimit: 30,
    maxLimit: 100,
    maxPage: 1000,
    includeMaxItems: 50,
} as const;

export const OUTBOX = { maxAttempts: 8, batchSize: 100, webhookTimeoutMs: 5000 } as const;

export const MAIL_FROM_NAME = 'Smart City';

export const UPLOADS_CACHE_MAX_AGE_SECONDS = 3600;
export const UPLOAD_LIMITS = { maxPixels: 40_000_000, maxDimension: 10_000 } as const;

export const JOB_CRON = {
    recurrentSlots: '0 3 * * *',
    newsExpiry: '0 */2 * * *',
    slotExpiry: '30 3 * * *',
    staleBookings: '0 4 * * *',
    cascadeReconcile: '30 4 * * *',
    storageGc: '0 5 * * *',
    debtorReport: '0 12 * * *',
    unreferencedImages: '30 12 * * *',
    outboxDispatch: '* * * * *',
    bookingReminders: '0 * * * *',
    trashPurge: '0 6 * * *',
} as const;

export const JOB_LOCK_TTL_SECONDS = 300;
export const JOB_CASCADE_RECONCILE_LIMIT = 25;
export const STORAGE_GC_MIN_AGE_SECONDS = 24 * 3600;
