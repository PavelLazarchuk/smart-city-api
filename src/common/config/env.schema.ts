import { z } from 'zod';

const csv = z
    .string()
    .default('')
    .transform((value) =>
        value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
    );

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
/** Durations such as `15m`, `30d`, `900s`, `2h`, or a bare number of seconds; parsed to seconds. */
export const durationSchema = z
    .string()
    .regex(/^\d+(s|m|h|d)?$/, 'Must be a duration like 15m, 12h, 30d or a number of seconds')
    .transform((value) => {
        const match = /^(\d+)(s|m|h|d)?$/.exec(value);
        const amount = Number(match?.[1] ?? 0);
        const unit = match?.[2] ?? 's';
        const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;

        return amount * multiplier;
    });

const optionalString = z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const LOGIN_METHODS = ['password', 'sms'] as const;

/** Every environment variable the app reads. The app refuses to boot when this schema does not parse. */
export const envSchema = z
    .object({
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
        PORT: positiveInt(8080),
        API_PREFIX: z.string().default('api/v1'),
        LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
        SWAGGER_ENABLED: z.stringbool().optional(),
        CORS_ORIGINS: csv,
        BODY_LIMIT: z.string().default('1mb'),
        TRUST_PROXY: z.stringbool().default(false),

        MONGO_URI: z.string().min(1),
        MONGO_MAX_POOL_SIZE: positiveInt(20),
        MONGO_MIN_POOL_SIZE: z.coerce.number().int().min(0).default(0),
        MONGO_SERVER_SELECTION_TIMEOUT_MS: positiveInt(10_000),
        MONGO_SOCKET_TIMEOUT_MS: positiveInt(45_000),
        MONGO_RETRY_WRITES: z.stringbool().default(true),
        MONGO_WRITE_CONCERN: z.enum(['majority', '1']).default('majority'),
        MONGO_READ_PREFERENCE: z
            .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
            .default('primary'),

        METRICS_ENABLED: z.stringbool().default(true),
        METRICS_TOKEN: optionalString,

        BUILD_VERSION: optionalString,
        BUILD_SHA: optionalString,

        JWT_ACCESS_SECRET: z.string().min(32),
        JWT_REFRESH_SECRET: z.string().min(32),
        JWT_ACCESS_TTL: durationSchema.default(5 * 60),
        JWT_REFRESH_TTL: durationSchema.default(7 * 24 * 3600),
        AUTH_ADMIN_LOGIN_METHOD: z.enum(LOGIN_METHODS).default('password'),
        AUTH_CITIZEN_LOGIN_METHOD: z.enum(LOGIN_METHODS).default('sms'),
        ARGON2_MEMORY_COST: positiveInt(19456),
        ARGON2_TIME_COST: positiveInt(2),
        ARGON2_PARALLELISM: positiveInt(1),
        PASSWORD_MIN_LENGTH: positiveInt(8),
        LOGIN_MIN_LENGTH: positiveInt(5),
        AUTH_MAX_FAILED_ATTEMPTS: positiveInt(5),
        AUTH_LOCKOUT_SECONDS: positiveInt(300),
        AUTH_LOCKOUT_MAX_SECONDS: positiveInt(3600),
        AUTH_FAILED_ATTEMPT_WINDOW_SECONDS: positiveInt(3600),

        OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
        OTP_TTL_SECONDS: positiveInt(300),
        OTP_MAX_ATTEMPTS: positiveInt(5),

        PHONE_COUNTRY_CODE: z
            .string()
            .regex(/^\d{1,3}$/)
            .default('375'),

        THROTTLE_TTL_SECONDS: positiveInt(60),
        THROTTLE_LIMIT: positiveInt(10),
        THROTTLE_GLOBAL_LIMIT: positiveInt(200),
        THROTTLE_UPLOAD_LIMIT: positiveInt(20),
        THROTTLE_STORAGE: z.enum(['mongo', 'memory']).default('mongo'),

        PAGINATION_DEFAULT_LIMIT: positiveInt(30),
        PAGINATION_MAX_LIMIT: positiveInt(100),
        PAGINATION_MAX_PAGE: positiveInt(1000),
        INCLUDE_MAX_ITEMS: positiveInt(50),

        SMS_PROVIDER: z.enum(['console', 'smpp']).default('console'),
        SMPP_URL: optionalString,
        SMPP_SYSTEM_ID: optionalString,
        SMPP_PASSWORD: optionalString,
        SMPP_SOURCE_ADDR: z.string().default('SmartCity'),
        SMS_HOURLY_LIMIT: z.coerce.number().int().min(0).default(200),
        SMS_DAILY_LIMIT: z.coerce.number().int().min(0).default(1000),

        MAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
        SMTP_HOST: optionalString,
        SMTP_PORT: positiveInt(587),
        SMTP_SECURE: z.stringbool().default(false),
        SMTP_USER: optionalString,
        SMTP_PASSWORD: optionalString,
        SMTP_REJECT_UNAUTHORIZED: z.stringbool().default(true),
        MAIL_FROM_NAME: z.string().default('Smart City'),
        MAIL_FROM_ADDRESS: z.email().default('noreply@example.com'),

        STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
        STORAGE_LOCAL_DIR: z.string().default('./uploads'),
        STORAGE_PUBLIC_URL: z.string().default('http://localhost:8080/uploads'),
        S3_BUCKET: optionalString,
        S3_REGION: optionalString,
        S3_ENDPOINT: optionalString,
        S3_ACCESS_KEY_ID: optionalString,
        S3_SECRET_ACCESS_KEY: optionalString,
        UPLOAD_MAX_BYTES: positiveInt(10 * 1024 * 1024),
        UPLOAD_ALLOWED_MIME: z
            .string()
            .default('image/jpeg,image/png')
            .transform((value) =>
                value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
            ),

        ARCHIVE_RETENTION_DAYS: positiveInt(30),
        ANALYTICS_RETENTION_DAYS: positiveInt(365),
        SMS_RETENTION_DAYS: positiveInt(365),
        RECURRENT_HORIZON_DAYS: positiveInt(30),

        JOBS_ENABLED: z.stringbool().default(false),
        JOBS_TIMEZONE: z.string().default('UTC'),
        JOB_LOCK_TTL_SECONDS: positiveInt(300),
        JOB_RECURRENT_SLOTS_CRON: z.string().default('0 3 * * *'),
        JOB_NEWS_EXPIRY_CRON: z.string().default('0 */2 * * *'),
        JOB_SLOT_EXPIRY_CRON: z.string().default('30 3 * * *'),
        JOB_STALE_BOOKINGS_CRON: z.string().default('0 4 * * *'),
        JOB_CASCADE_RECONCILE_CRON: z.string().default('30 4 * * *'),
        /** Above this many dangling organizations `cascade_reconcile` reports and deletes nothing. */
        JOB_CASCADE_RECONCILE_LIMIT: positiveInt(25),
        JOB_STORAGE_GC_CRON: z.string().default('0 5 * * *'),
        JOB_DEBTOR_REPORT_CRON: z.string().default('0 12 * * *'),
        JOB_UNREFERENCED_IMAGES_CRON: z.string().default('30 12 * * *'),
        /** How long a stored file is left alone before `storage_gc` may treat it as an orphan. */
        STORAGE_GC_MIN_AGE: durationSchema.default(24 * 3600),
        REPORT_RECIPIENTS: csv,
    })
    .superRefine((env, ctx) => {
        if (env.SMS_PROVIDER === 'smpp') {
            for (const key of ['SMPP_URL', 'SMPP_SYSTEM_ID', 'SMPP_PASSWORD'] as const) {
                if (!env[key])
                    ctx.addIssue({
                        code: 'custom',
                        path: [key],
                        message: `${key} is required when SMS_PROVIDER=smpp`,
                    });
            }
        }

        if (env.MAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
            ctx.addIssue({
                code: 'custom',
                path: ['SMTP_HOST'],
                message: 'SMTP_HOST is required when MAIL_PROVIDER=smtp',
            });
        }

        if (env.STORAGE_PROVIDER === 's3') {
            for (const key of ['S3_BUCKET', 'S3_REGION'] as const) {
                if (!env[key])
                    ctx.addIssue({
                        code: 'custom',
                        path: [key],
                        message: `${key} is required when STORAGE_PROVIDER=s3`,
                    });
            }
        }

        if (env.PAGINATION_DEFAULT_LIMIT > env.PAGINATION_MAX_LIMIT) {
            ctx.addIssue({
                code: 'custom',
                path: ['PAGINATION_DEFAULT_LIMIT'],
                message: 'PAGINATION_DEFAULT_LIMIT must not exceed PAGINATION_MAX_LIMIT',
            });
        }

        if (env.AUTH_LOCKOUT_MAX_SECONDS < env.AUTH_LOCKOUT_SECONDS) {
            ctx.addIssue({
                code: 'custom',
                path: ['AUTH_LOCKOUT_MAX_SECONDS'],
                message: 'AUTH_LOCKOUT_MAX_SECONDS must not be below AUTH_LOCKOUT_SECONDS',
            });
        }

        // A window shorter than one lock would reset the counter while the account is still locked,
        // so the escalation — and with it AUTH_LOCKOUT_MAX_SECONDS — could never be reached.
        if (env.AUTH_FAILED_ATTEMPT_WINDOW_SECONDS < env.AUTH_LOCKOUT_SECONDS) {
            ctx.addIssue({
                code: 'custom',
                path: ['AUTH_FAILED_ATTEMPT_WINDOW_SECONDS'],
                message: 'AUTH_FAILED_ATTEMPT_WINDOW_SECONDS must not be below AUTH_LOCKOUT_SECONDS',
            });
        }

        if (env.NODE_ENV === 'production') {
            if (env.METRICS_ENABLED && !env.METRICS_TOKEN) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['METRICS_TOKEN'],
                    message: 'METRICS_TOKEN is required when metrics are exposed in production',
                });
            }

            if (env.SMS_PROVIDER === 'console') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['SMS_PROVIDER'],
                    message: 'SMS_PROVIDER must not be "console" in production',
                });
            }

            if (env.MAIL_PROVIDER === 'console') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['MAIL_PROVIDER'],
                    message: 'MAIL_PROVIDER must not be "console" in production',
                });
            }
        }

        if (env.NODE_ENV === 'production' && env.JOBS_ENABLED && env.REPORT_RECIPIENTS.length === 0) {
            ctx.addIssue({
                code: 'custom',
                path: ['REPORT_RECIPIENTS'],
                message: 'REPORT_RECIPIENTS is required when jobs run',
            });
        }
    });

export type Env = z.infer<typeof envSchema>;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export function validateEnv(raw: Record<string, unknown>): Env {
    const result = envSchema.safeParse(raw);

    if (!result.success) {
        const lines = result.error.issues.map(
            (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
        );
        throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
    }

    return result.data;
}
