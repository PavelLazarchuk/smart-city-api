import { AppConfig } from './app-config';
import { durationSchema, validateEnv } from './env.schema';

const base = {
    MONGO_URI: 'mongodb://localhost/x',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('env schema', () => {
    it('parses durations to seconds', () => {
        expect(durationSchema.parse('15m')).toBe(900);
        expect(durationSchema.parse('30d')).toBe(30 * 86400);
        expect(durationSchema.parse('2h')).toBe(7200);
        expect(durationSchema.parse('45')).toBe(45);
        expect(() => durationSchema.parse('1w')).toThrow();
    });

    it('applies defaults and coerces types', () => {
        const env = validateEnv(base);
        expect(env.PORT).toBe(8080);
        expect(env.JWT_ACCESS_TTL).toBe(300);
        expect(env.CORS_ORIGINS).toEqual([]);
        expect(env.UPLOAD_ALLOWED_MIME).toEqual(['image/jpeg', 'image/png']);
        expect(env.JOBS_ENABLED).toBe(false);
        expect(validateEnv({ ...base, JOBS_ENABLED: 'true', CORS_ORIGINS: 'a.com, b.com' })).toMatchObject({
            JOBS_ENABLED: true,
            CORS_ORIGINS: ['a.com', 'b.com'],
        });
    });

    it('refuses the console providers in production, and allows them everywhere else', () => {
        expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/SMS_PROVIDER/);
        expect(() =>
            validateEnv({
                ...base,
                NODE_ENV: 'production',
                SMS_PROVIDER: 'smpp',
                SMPP_URL: 'smpp://host:2775',
                SMPP_SYSTEM_ID: 'id',
                SMPP_PASSWORD: 'secret',
            }),
        ).toThrow(/MAIL_PROVIDER/);
        expect(
            validateEnv({
                ...base,
                NODE_ENV: 'production',
                SMS_PROVIDER: 'smpp',
                SMPP_URL: 'smpp://host:2775',
                SMPP_SYSTEM_ID: 'id',
                SMPP_PASSWORD: 'secret',
                MAIL_PROVIDER: 'smtp',
                SMTP_HOST: 'mail.example.com',
                METRICS_TOKEN: 'metrics-token',
            }),
        ).toMatchObject({ SMS_PROVIDER: 'smpp', MAIL_PROVIDER: 'smtp' });
        expect(validateEnv(base).SMS_PROVIDER).toBe('console');
    });

    it('leaves Swagger to the environment: on by default, off in production unless asked for', () => {
        expect(new AppConfig(validateEnv(base)).http.swaggerEnabled).toBe(true);
        const production = {
            ...base,
            NODE_ENV: 'production',
            SMS_PROVIDER: 'smpp',
            SMPP_URL: 'smpp://host:2775',
            SMPP_SYSTEM_ID: 'id',
            SMPP_PASSWORD: 'secret',
            MAIL_PROVIDER: 'smtp',
            SMTP_HOST: 'mail.example.com',
            METRICS_TOKEN: 'metrics-token',
        };
        expect(new AppConfig(validateEnv(production)).http.swaggerEnabled).toBe(false);
        expect(
            new AppConfig(validateEnv({ ...production, SWAGGER_ENABLED: 'true' })).http.swaggerEnabled,
        ).toBe(true);
    });

    it('refuses an unprotected metrics endpoint in production, and allows it when switched off', () => {
        const production = {
            ...base,
            NODE_ENV: 'production',
            SMS_PROVIDER: 'smpp',
            SMPP_URL: 'smpp://host:2775',
            SMPP_SYSTEM_ID: 'id',
            SMPP_PASSWORD: 'secret',
            MAIL_PROVIDER: 'smtp',
            SMTP_HOST: 'mail.example.com',
        };
        expect(() => validateEnv(production)).toThrow(/METRICS_TOKEN/);
        expect(validateEnv({ ...production, METRICS_ENABLED: 'false' }).METRICS_ENABLED).toBe(false);
        expect(validateEnv(base).METRICS_TOKEN).toBeUndefined();
    });

    it('keeps the lockout window ordered and pins the Mongo connection defaults', () => {
        expect(() => validateEnv({ ...base, AUTH_LOCKOUT_MAX_SECONDS: '60' })).toThrow(
            /AUTH_LOCKOUT_MAX_SECONDS/,
        );

        // A decay window shorter than one lock would reset the counter while the account is still locked.
        expect(() =>
            validateEnv({ ...base, AUTH_LOCKOUT_SECONDS: '600', AUTH_FAILED_ATTEMPT_WINDOW_SECONDS: '300' }),
        ).toThrow(/AUTH_FAILED_ATTEMPT_WINDOW_SECONDS/);
        expect(new AppConfig(validateEnv(base)).auth.failedAttemptWindowSeconds).toBe(3600);

        const mongo = new AppConfig(validateEnv(base)).mongo;
        expect(mongo).toMatchObject({
            maxPoolSize: 20,
            retryWrites: true,
            writeConcern: 'majority',
            readPreference: 'primary',
        });
    });

    it('refuses to boot on missing or malformed values with a readable message', () => {
        expect(() => validateEnv({})).toThrow(/MONGO_URI/);
        expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
        expect(() => validateEnv({ ...base, SMS_PROVIDER: 'smpp' })).toThrow(/SMPP_URL/);
        expect(() =>
            validateEnv({ ...base, PAGINATION_DEFAULT_LIMIT: '200', PAGINATION_MAX_LIMIT: '100' }),
        ).toThrow(/PAGINATION_DEFAULT_LIMIT/);
    });
});
