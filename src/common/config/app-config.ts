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
        writeConcern: Env['MONGO_WRITE_CONCERN'];
        readPreference: Env['MONGO_READ_PREFERENCE'];
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

    readonly idempotency: { ttlSeconds: number };

    readonly site: { publicUrl: string; defaultCurrency: string };

    readonly outbox: {
        maxAttempts: number;
        batchSize: number;
        webhookTimeoutMs: number;
        allowPrivateHosts: boolean;
    };

    readonly bookings: { reminderHours: number; historyRetentionDays: number };

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

    readonly retention: {
        archiveDays: number;
        analyticsDays: number;
        smsDays: number;
        serviceTrashDays: number;
        recurrentHorizonDays: number;
    };

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
            bodyLimit: env.BODY_LIMIT,
            trustProxy: env.TRUST_PROXY,
            swaggerEnabled: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
        };
        this.log = { level: env.LOG_LEVEL };
        this.mongo = {
            uri: env.MONGO_URI,
            autoIndex: env.NODE_ENV !== 'production',
            maxPoolSize: env.MONGO_MAX_POOL_SIZE,
            minPoolSize: Math.min(env.MONGO_MIN_POOL_SIZE, env.MONGO_MAX_POOL_SIZE),
            serverSelectionTimeoutMs: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
            socketTimeoutMs: env.MONGO_SOCKET_TIMEOUT_MS,
            retryWrites: env.MONGO_RETRY_WRITES,
            writeConcern: env.MONGO_WRITE_CONCERN,
            readPreference: env.MONGO_READ_PREFERENCE,
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
            argon2: {
                memoryCost: env.ARGON2_MEMORY_COST,
                timeCost: env.ARGON2_TIME_COST,
                parallelism: env.ARGON2_PARALLELISM,
            },
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
        this.idempotency = { ttlSeconds: env.IDEMPOTENCY_TTL };
        this.site = {
            publicUrl: env.PUBLIC_SITE_URL.replace(/\/+$/, ''),
            defaultCurrency: env.DEFAULT_CURRENCY,
        };
        this.outbox = {
            maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
            batchSize: env.OUTBOX_BATCH_SIZE,
            webhookTimeoutMs: env.WEBHOOK_TIMEOUT_MS,
            allowPrivateHosts: env.WEBHOOK_ALLOW_PRIVATE_HOSTS,
        };
        this.bookings = {
            reminderHours: env.BOOKING_REMINDER_HOURS,
            historyRetentionDays: env.BOOKING_HISTORY_RETENTION_DAYS,
        };
        this.pagination = {
            defaultLimit: env.PAGINATION_DEFAULT_LIMIT,
            maxLimit: env.PAGINATION_MAX_LIMIT,
            maxPage: env.PAGINATION_MAX_PAGE,
            includeMaxItems: env.INCLUDE_MAX_ITEMS,
        };
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
            from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM_ADDRESS },
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
            cacheMaxAgeSeconds: env.UPLOADS_CACHE_MAX_AGE,
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
            maxPixels: env.UPLOAD_MAX_PIXELS,
            maxDimension: env.UPLOAD_MAX_DIMENSION,
            allowedMime: env.UPLOAD_ALLOWED_MIME,
        };
        this.retention = {
            archiveDays: env.ARCHIVE_RETENTION_DAYS,
            analyticsDays: env.ANALYTICS_RETENTION_DAYS,
            smsDays: env.SMS_RETENTION_DAYS,
            serviceTrashDays: env.SERVICE_TRASH_RETENTION_DAYS,
            recurrentHorizonDays: env.RECURRENT_HORIZON_DAYS,
        };
        this.jobs = {
            enabled: env.JOBS_ENABLED,
            timezone: env.JOBS_TIMEZONE,
            lockTtlSeconds: env.JOB_LOCK_TTL_SECONDS,
            cron: {
                recurrentSlots: env.JOB_RECURRENT_SLOTS_CRON,
                newsExpiry: env.JOB_NEWS_EXPIRY_CRON,
                slotExpiry: env.JOB_SLOT_EXPIRY_CRON,
                staleBookings: env.JOB_STALE_BOOKINGS_CRON,
                cascadeReconcile: env.JOB_CASCADE_RECONCILE_CRON,
                storageGc: env.JOB_STORAGE_GC_CRON,
                debtorReport: env.JOB_DEBTOR_REPORT_CRON,
                unreferencedImages: env.JOB_UNREFERENCED_IMAGES_CRON,
                outboxDispatch: env.JOB_OUTBOX_DISPATCH_CRON,
                bookingReminders: env.JOB_BOOKING_REMINDERS_CRON,
                trashPurge: env.JOB_TRASH_PURGE_CRON,
            },
            cascadeReconcileLimit: env.JOB_CASCADE_RECONCILE_LIMIT,
            storageGcMinAgeSeconds: env.STORAGE_GC_MIN_AGE,
            reportRecipients: env.REPORT_RECIPIENTS,
        };
    }
}
