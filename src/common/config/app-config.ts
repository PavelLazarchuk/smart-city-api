import {
    ARGON2_PARAMS,
    ARGON2_TEST_PARAMS,
    HTTP_BODY_LIMIT,
    IDEMPOTENCY_TTL_SECONDS,
    JOB_CASCADE_RECONCILE_LIMIT,
    JOB_CRON,
    JOB_LOCK_TTL_SECONDS,
    MAIL_FROM_NAME,
    MONGO_CONNECTION,
    OUTBOX,
    REDIS_CONNECTION,
    PAGINATION,
    STORAGE_GC_MIN_AGE_SECONDS,
    UPLOAD_LIMITS,
    UPLOADS_CACHE_MAX_AGE_SECONDS,
} from './constants';
import { type Env, type LoginMethod } from './env.schema';

export interface JwtKeySet {
    kid: string;
    secret: string;
    accepted: Record<string, string>;
}

function keySet(kid: string, secret: string, previous: { kid: string; secret: string }[]): JwtKeySet {
    const accepted: Record<string, string> = { [kid]: secret };

    for (const key of previous) accepted[key.kid] = key.secret;

    return { kid, secret, accepted };
}

export class AppConfig {
    readonly env: Env['NODE_ENV'];
    readonly isProduction: boolean;
    readonly isTest: boolean;

    readonly http: {
        port: number;
        prefix: string;
        corsOrigins: string[];
        bodyLimit: string;
        trustProxy: boolean;
        swaggerEnabled: boolean;
    };

    readonly log: { level: Env['LOG_LEVEL'] };

    readonly mongo: {
        uri: string;
        autoIndex: boolean;
        maxPoolSize: number;
        minPoolSize: number;
        serverSelectionTimeoutMs: number;
        socketTimeoutMs: number;
        retryWrites: boolean;
        writeConcern: typeof MONGO_CONNECTION.writeConcern;
        readPreference: typeof MONGO_CONNECTION.readPreference;
    };

    readonly metrics: { enabled: boolean; token?: string };

    readonly build: { version: string; sha?: string };

    readonly auth: {
        access: JwtKeySet;
        refresh: JwtKeySet;
        issuer: string;
        audience: string;
        accessTtlSeconds: number;
        refreshTtlSeconds: number;
        adminLoginMethod: LoginMethod;
        clientLoginMethod: LoginMethod;
        maxFailedAttempts: number;
        lockoutSeconds: number;
        lockoutMaxSeconds: number;
        failedAttemptWindowSeconds: number;
        argon2: { memoryCost: number; timeCost: number; parallelism: number };
    };

    readonly otp: { length: number; ttlSeconds: number; maxAttempts: number };

    readonly phone: { countryCode: string };

    readonly throttle: {
        ttlSeconds: number;
        limit: number;
        globalLimit: number;
        uploadLimit: number;
        storage: Env['THROTTLE_STORAGE'];
    };

    readonly redis: { url: string; keyPrefix: string };

    readonly idempotency: { ttlSeconds: number };

    readonly site: { publicUrl: string; defaultCurrency: string };

    readonly outbox: {
        maxAttempts: number;
        batchSize: number;
        webhookTimeoutMs: number;
        allowPrivateHosts: boolean;
    };

    readonly bookings: { reminderHours: number };

    readonly pagination: { defaultLimit: number; maxLimit: number; maxPage: number; includeMaxItems: number };

    readonly sms: {
        provider: Env['SMS_PROVIDER'];
        smpp: { url?: string; systemId?: string; password?: string; sourceAddr: string };
        budget: { hourlyLimit: number; dailyLimit: number };
    };

    readonly mail: {
        provider: Env['MAIL_PROVIDER'];
        from: { name: string; address: string };
        smtp: {
            host?: string;
            port: number;
            secure: boolean;
            user?: string;
            password?: string;
            rejectUnauthorized: boolean;
        };
    };

    readonly storage: {
        provider: Env['STORAGE_PROVIDER'];
        local: { dir: string; publicUrl: string };
        corsOrigins: string[];
        cacheMaxAgeSeconds: number;
        s3: {
            bucket?: string;
            region?: string;
            endpoint?: string;
            accessKeyId?: string;
            secretAccessKey?: string;
        };
    };

    readonly upload: { maxBytes: number; maxPixels: number; maxDimension: number; allowedMime: string[] };

    readonly retention: { serviceTrashDays: number; recurrentHorizonDays: number };

    readonly jobs: {
        enabled: boolean;
        timezone: string;
        lockTtlSeconds: number;
        cron: {
            recurrentSlots: string;
            newsExpiry: string;
            slotExpiry: string;
            staleBookings: string;
            cascadeReconcile: string;
            storageGc: string;
            debtorReport: string;
            unreferencedImages: string;
            outboxDispatch: string;
            bookingReminders: string;
            trashPurge: string;
        };
        cascadeReconcileLimit: number;
        storageGcMinAgeSeconds: number;
        reportRecipients: string[];
    };

    constructor(env: Env) {
        this.env = env.NODE_ENV;
        this.isProduction = env.NODE_ENV === 'production';
        this.isTest = env.NODE_ENV === 'test';

        this.http = {
            port: env.PORT,
            prefix: env.API_PREFIX.replace(/^\/+|\/+$/g, ''),
            corsOrigins: env.CORS_ORIGINS,
            bodyLimit: HTTP_BODY_LIMIT,
            trustProxy: env.TRUST_PROXY,
            swaggerEnabled: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
        };
        this.log = { level: env.LOG_LEVEL };
        this.mongo = {
            uri: env.MONGO_URI,
            autoIndex: env.NODE_ENV !== 'production',
            maxPoolSize: env.MONGO_MAX_POOL_SIZE,
            minPoolSize: MONGO_CONNECTION.minPoolSize,
            serverSelectionTimeoutMs: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
            socketTimeoutMs: env.MONGO_SOCKET_TIMEOUT_MS,
            retryWrites: MONGO_CONNECTION.retryWrites,
            writeConcern: MONGO_CONNECTION.writeConcern,
            readPreference: MONGO_CONNECTION.readPreference,
        };
        this.metrics = { enabled: env.METRICS_ENABLED, token: env.METRICS_TOKEN };
        this.build = { version: env.BUILD_VERSION ?? '1.0.0', sha: env.BUILD_SHA };
        this.auth = {
            access: keySet(env.JWT_ACCESS_KID, env.JWT_ACCESS_SECRET, env.JWT_ACCESS_PREVIOUS_KEYS),
            refresh: keySet(env.JWT_REFRESH_KID, env.JWT_REFRESH_SECRET, env.JWT_REFRESH_PREVIOUS_KEYS),
            issuer: env.JWT_ISSUER,
            audience: env.JWT_AUDIENCE,
            accessTtlSeconds: env.JWT_ACCESS_TTL,
            refreshTtlSeconds: env.JWT_REFRESH_TTL,
            adminLoginMethod: env.AUTH_ADMIN_LOGIN_METHOD,
            clientLoginMethod: env.AUTH_CLIENT_LOGIN_METHOD,
            maxFailedAttempts: env.AUTH_MAX_FAILED_ATTEMPTS,
            lockoutSeconds: env.AUTH_LOCKOUT_SECONDS,
            lockoutMaxSeconds: env.AUTH_LOCKOUT_MAX_SECONDS,
            failedAttemptWindowSeconds: env.AUTH_FAILED_ATTEMPT_WINDOW_SECONDS,
            argon2: env.NODE_ENV === 'test' ? ARGON2_TEST_PARAMS : ARGON2_PARAMS,
        };
        this.otp = {
            length: env.OTP_LENGTH,
            ttlSeconds: env.OTP_TTL_SECONDS,
            maxAttempts: env.OTP_MAX_ATTEMPTS,
        };
        this.phone = { countryCode: env.PHONE_COUNTRY_CODE };
        this.throttle = {
            ttlSeconds: env.THROTTLE_TTL_SECONDS,
            limit: env.THROTTLE_LIMIT,
            globalLimit: env.THROTTLE_GLOBAL_LIMIT,
            uploadLimit: env.THROTTLE_UPLOAD_LIMIT,
            storage: env.THROTTLE_STORAGE,
        };
        this.redis = {
            url: env.REDIS_URL ?? REDIS_CONNECTION.defaultUrl,
            keyPrefix: REDIS_CONNECTION.keyPrefix,
        };
        this.idempotency = { ttlSeconds: IDEMPOTENCY_TTL_SECONDS };
        this.site = {
            publicUrl: env.PUBLIC_SITE_URL.replace(/\/+$/, ''),
            defaultCurrency: env.DEFAULT_CURRENCY,
        };
        this.outbox = {
            maxAttempts: OUTBOX.maxAttempts,
            batchSize: OUTBOX.batchSize,
            webhookTimeoutMs: OUTBOX.webhookTimeoutMs,
            allowPrivateHosts: env.WEBHOOK_ALLOW_PRIVATE_HOSTS,
        };
        this.bookings = { reminderHours: env.BOOKING_REMINDER_HOURS };
        this.pagination = { ...PAGINATION };
        this.sms = {
            provider: env.SMS_PROVIDER,
            smpp: {
                url: env.SMPP_URL,
                systemId: env.SMPP_SYSTEM_ID,
                password: env.SMPP_PASSWORD,
                sourceAddr: env.SMPP_SOURCE_ADDR,
            },
            budget: { hourlyLimit: env.SMS_HOURLY_LIMIT, dailyLimit: env.SMS_DAILY_LIMIT },
        };
        this.mail = {
            provider: env.MAIL_PROVIDER,
            from: { name: MAIL_FROM_NAME, address: env.MAIL_FROM_ADDRESS },
            smtp: {
                host: env.SMTP_HOST,
                port: env.SMTP_PORT,
                secure: env.SMTP_SECURE,
                user: env.SMTP_USER,
                password: env.SMTP_PASSWORD,
                rejectUnauthorized: env.SMTP_REJECT_UNAUTHORIZED,
            },
        };
        this.storage = {
            provider: env.STORAGE_PROVIDER,
            local: { dir: env.STORAGE_LOCAL_DIR, publicUrl: env.STORAGE_PUBLIC_URL.replace(/\/+$/, '') },
            corsOrigins: env.UPLOADS_CORS_ORIGINS.length > 0 ? env.UPLOADS_CORS_ORIGINS : env.CORS_ORIGINS,
            cacheMaxAgeSeconds: UPLOADS_CACHE_MAX_AGE_SECONDS,
            s3: {
                bucket: env.S3_BUCKET,
                region: env.S3_REGION,
                endpoint: env.S3_ENDPOINT,
                accessKeyId: env.S3_ACCESS_KEY_ID,
                secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
        };
        this.upload = {
            maxBytes: env.UPLOAD_MAX_BYTES,
            maxPixels: UPLOAD_LIMITS.maxPixels,
            maxDimension: UPLOAD_LIMITS.maxDimension,
            allowedMime: env.UPLOAD_ALLOWED_MIME,
        };
        this.retention = {
            serviceTrashDays: env.SERVICE_TRASH_RETENTION_DAYS,
            recurrentHorizonDays: env.RECURRENT_HORIZON_DAYS,
        };
        this.jobs = {
            enabled: env.JOBS_ENABLED,
            timezone: env.JOBS_TIMEZONE,
            lockTtlSeconds: JOB_LOCK_TTL_SECONDS,
            cron: { ...JOB_CRON },
            cascadeReconcileLimit: JOB_CASCADE_RECONCILE_LIMIT,
            storageGcMinAgeSeconds: STORAGE_GC_MIN_AGE_SECONDS,
            reportRecipients: env.REPORT_RECIPIENTS,
        };
    }
}
