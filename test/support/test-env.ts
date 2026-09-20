import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function mongoUri(): string {
    const fromEnv = process.env['JEST_MONGO_URI'];
    const base =
        fromEnv ??
        (
            JSON.parse(readFileSync(join(process.cwd(), '.jest-cache', 'mongo.json'), 'utf8')) as {
                uri: string;
            }
        ).uri;
    const dbName = `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    return base.includes('/?') ? base.replace('/?', `/${dbName}?`) : `${base.replace(/\/$/, '')}/${dbName}`;
}

const defaults: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '3999',
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'true',
    CORS_ORIGINS: 'http://localhost:8080',
    MONGO_URI: mongoUri(),
    JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0000',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-00',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    AUTH_ADMIN_LOGIN_METHOD: 'password',
    AUTH_CITIZEN_LOGIN_METHOD: 'sms',
    ARGON2_MEMORY_COST: '4096',
    ARGON2_TIME_COST: '1',
    ARGON2_PARALLELISM: '1',
    OTP_LENGTH: '6',
    OTP_TTL_SECONDS: '300',
    OTP_MAX_ATTEMPTS: '3',
    PHONE_COUNTRY_CODE: '375',
    THROTTLE_TTL_SECONDS: '60',
    THROTTLE_LIMIT: '1000',
    THROTTLE_GLOBAL_LIMIT: '100000',
    THROTTLE_UPLOAD_LIMIT: '1000',
    THROTTLE_STORAGE: 'memory',
    PAGINATION_DEFAULT_LIMIT: '30',
    PAGINATION_MAX_LIMIT: '100',
    INCLUDE_MAX_ITEMS: '50',
    SMS_PROVIDER: 'console',
    MAIL_PROVIDER: 'console',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: join(process.cwd(), '.jest-cache', 'uploads'),
    STORAGE_PUBLIC_URL: 'http://localhost:8080/uploads',
    UPLOAD_MAX_BYTES: '1048576',
    UPLOAD_ALLOWED_MIME: 'image/jpeg,image/png',
    ARCHIVE_RETENTION_DAYS: '90',
    RECURRENT_HORIZON_DAYS: '30',
    JOBS_ENABLED: 'false',
    JOBS_TIMEZONE: 'UTC',
    JOB_LOCK_TTL_SECONDS: '5',
    REPORT_RECIPIENTS: 'reports@example.com',
    WEBHOOK_ALLOW_PRIVATE_HOSTS: 'true',
    WEBHOOK_TIMEOUT_MS: '2000',
    PUBLIC_SITE_URL: 'https://city.example.com',
};

for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || key === 'MONGO_URI' || key === 'NODE_ENV') process.env[key] = value;
}
