import { type Env, type LoginMethod } from './env.schema';

/** Typed view over the validated environment. Sections are plain objects, so tests can override values. */
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

    readonly mongo: { uri: string; autoIndex: boolean };

    readonly auth: {
        accessSecret: string;
        refreshSecret: string;
        accessTtlSeconds: number;
        refreshTtlSeconds: number;
        adminLoginMethod: LoginMethod;
        citizenLoginMethod: LoginMethod;
        passwordMinLength: number;
        loginMinLength: number;
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

    readonly pagination: { defaultLimit: number; maxLimit: number; maxPage: number; includeMaxItems: number };

    readonly sms: {
        provider: Env['SMS_PROVIDER'];
        smpp: { url?: string; systemId?: string; password?: string; sourceAddr: string };
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
        s3: {
            bucket?: string;
            region?: string;
            endpoint?: string;
            accessKeyId?: string;
            secretAccessKey?: string;
        };
    };

    readonly upload: { maxBytes: number; allowedMime: string[] };

    readonly retention: { archiveDays: number; analyticsDays: number; recurrentHorizonDays: number };

    readonly jobs: {
        enabled: boolean;
        timezone: string;
        lockTtlSeconds: number;
        cron: {
            recurrentSlots: string;
            newsExpiry: string;
            slotExpiry: string;
            staleBookings: string;
            debtorReport: string;
        };
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
        this.mongo = { uri: env.MONGO_URI, autoIndex: env.NODE_ENV !== 'production' };
        this.auth = {
            accessSecret: env.JWT_ACCESS_SECRET,
            refreshSecret: env.JWT_REFRESH_SECRET,
            accessTtlSeconds: env.JWT_ACCESS_TTL,
            refreshTtlSeconds: env.JWT_REFRESH_TTL,
            adminLoginMethod: env.AUTH_ADMIN_LOGIN_METHOD,
            citizenLoginMethod: env.AUTH_CITIZEN_LOGIN_METHOD,
            passwordMinLength: env.PASSWORD_MIN_LENGTH,
            loginMinLength: env.LOGIN_MIN_LENGTH,
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
            s3: {
                bucket: env.S3_BUCKET,
                region: env.S3_REGION,
                endpoint: env.S3_ENDPOINT,
                accessKeyId: env.S3_ACCESS_KEY_ID,
                secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
        };
        this.upload = { maxBytes: env.UPLOAD_MAX_BYTES, allowedMime: env.UPLOAD_ALLOWED_MIME };
        this.retention = {
            archiveDays: env.ARCHIVE_RETENTION_DAYS,
            analyticsDays: env.ANALYTICS_RETENTION_DAYS,
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
                debtorReport: env.JOB_DEBTOR_REPORT_CRON,
            },
            reportRecipients: env.REPORT_RECIPIENTS,
        };
    }
}
