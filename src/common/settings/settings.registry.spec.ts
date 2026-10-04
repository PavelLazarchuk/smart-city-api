import { AppConfig } from '../config/app-config';
import { validateEnv } from '../config/env.schema';
import {
    crossRuleViolations,
    groupOf,
    isSettingKey,
    SETTING_KEYS,
    SETTINGS,
    type SettingsValues,
} from './settings.registry';

const config = new AppConfig(
    validateEnv({
        MONGO_URI: 'mongodb://localhost/x',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
    }),
);

const defaults = (): SettingsValues =>
    Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTINGS[key].fromConfig(config)])) as SettingsValues;

describe('settings registry', () => {
    it('names every key group.snake_case', () => {
        for (const key of SETTING_KEYS) expect(key).toMatch(/^[a-z]+\.[a-z_]+$/);
    });

    it('takes every default from the environment and accepts it under its own schema', () => {
        for (const key of SETTING_KEYS) {
            const result = SETTINGS[key].schema(config).safeParse(SETTINGS[key].fromConfig(config));

            expect({ key, success: result.success }).toEqual({ key, success: true });
        }

        expect(SETTINGS['auth.lockout_seconds'].fromConfig(config)).toBe(config.auth.lockoutSeconds);
        expect(SETTINGS['upload.allowed_mime'].fromConfig(config)).toEqual(config.upload.allowedMime);
    });

    it('caps upload.max_bytes at the environment ceiling', () => {
        const schema = SETTINGS['upload.max_bytes'].schema(config);

        expect(schema.safeParse(config.upload.maxBytes).success).toBe(true);
        expect(schema.safeParse(config.upload.maxBytes + 1).success).toBe(false);
        expect(schema.safeParse(512).success).toBe(false);
    });

    it('accepts only image types the upload check can verify, without repeats', () => {
        const schema = SETTINGS['upload.allowed_mime'].schema(config);

        expect(schema.safeParse(['image/webp']).success).toBe(true);
        expect(schema.safeParse(['image/svg+xml']).success).toBe(false);
        expect(schema.safeParse(['image/png', 'image/png']).success).toBe(false);
        expect(schema.safeParse([]).success).toBe(false);
    });

    it('rejects values of the wrong type or out of range', () => {
        expect(SETTINGS['auth.admin_login_method'].schema(config).safeParse('magic').success).toBe(false);
        expect(SETTINGS['otp.length'].schema(config).safeParse(11).success).toBe(false);
        expect(SETTINGS['otp.length'].schema(config).safeParse('6').success).toBe(false);
        expect(SETTINGS['site.default_currency'].schema(config).safeParse('eur').success).toBe(false);
    });

    it('reports cross-key violations on the resulting values', () => {
        expect(crossRuleViolations(defaults())).toEqual([]);
        expect(
            crossRuleViolations({
                ...defaults(),
                'auth.lockout_seconds': 600,
                'auth.lockout_max_seconds': 300,
            }),
        ).toEqual([{ path: 'auth.lockout_max_seconds', message: expect.any(String) }]);
        expect(
            crossRuleViolations({ ...defaults(), 'throttle.limit': 500, 'throttle.global_limit': 100 }),
        ).toEqual([{ path: 'throttle.global_limit', message: expect.any(String) }]);
    });

    it('tolerates a violation the environment already had, unless the write touches its keys', () => {
        const before = { ...defaults(), 'throttle.limit': 100, 'throttle.global_limit': 50 };
        const after = { ...before, 'otp.length': 8 };

        expect(crossRuleViolations(after, before, ['otp.length'])).toEqual([]);
        expect(
            crossRuleViolations({ ...before, 'throttle.limit': 1000 }, before, ['throttle.limit']).map(
                (violation) => violation.path,
            ),
        ).toEqual(['throttle.global_limit']);
    });

    it('lets either sms limit be unlimited', () => {
        const values = { ...defaults(), 'sms.hourly_limit': 500, 'sms.daily_limit': 100 };

        expect(crossRuleViolations(values).map((violation) => violation.path)).toEqual(['sms.daily_limit']);
        expect(crossRuleViolations({ ...values, 'sms.daily_limit': 0 })).toEqual([]);
        expect(crossRuleViolations({ ...values, 'sms.hourly_limit': 0 })).toEqual([]);
    });

    it('recognises only registered keys and splits them into group and name', () => {
        expect(isSettingKey('auth.lockout_seconds')).toBe(true);
        expect(isSettingKey('auth.secret')).toBe(false);
        expect(isSettingKey('toString')).toBe(false);
        expect(groupOf('retention.service_trash_days')).toBe('retention');
    });
});
