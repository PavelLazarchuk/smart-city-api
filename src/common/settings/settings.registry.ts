import { z, type ZodType } from 'zod';

import { type AppConfig } from '../config/app-config';
import { LOGIN_METHODS } from '../config/env.schema';
import { type ApiErrorDetail } from '../http/api-error';
import { emailSchema } from '../zod/primitives';

export const UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export const SETTINGS_REFRESH_MS = 10_000;

const UPLOAD_MIN_BYTES = 1024;
const REPORT_RECIPIENTS_MAX = 20;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

interface SettingDefinition<T> {
    description: string;
    schema: (config: AppConfig) => ZodType<T>;
    fromConfig: (config: AppConfig) => T;
}

const define = <T>(definition: SettingDefinition<T>): SettingDefinition<T> => definition;

export const SETTINGS = {
    'auth.admin_login_method': define({
        description: 'How staff sign in: login and password, or a one-time SMS code.',
        schema: () => z.enum(LOGIN_METHODS),
        fromConfig: (config) => config.auth.adminLoginMethod,
    }),
    'auth.client_login_method': define({
        description: 'How clients sign in: phone and password, or a one-time SMS code.',
        schema: () => z.enum(LOGIN_METHODS),
        fromConfig: (config) => config.auth.clientLoginMethod,
    }),
    'auth.max_failed_attempts': define({
        description: 'Wrong passwords in a row before the account is locked.',
        schema: () => int(3, 20),
        fromConfig: (config) => config.auth.maxFailedAttempts,
    }),
    'auth.lockout_seconds': define({
        description: 'First lock duration in seconds; every further failure doubles it.',
        schema: () => int(30, 86_400),
        fromConfig: (config) => config.auth.lockoutSeconds,
    }),
    'auth.lockout_max_seconds': define({
        description: 'Upper bound of the lock duration in seconds.',
        schema: () => int(30, 604_800),
        fromConfig: (config) => config.auth.lockoutMaxSeconds,
    }),
    'auth.failed_attempt_window_seconds': define({
        description: 'Failed attempts older than this many seconds no longer count.',
        schema: () => int(60, 604_800),
        fromConfig: (config) => config.auth.failedAttemptWindowSeconds,
    }),
    'auth.access_ttl_seconds': define({
        description: 'Access token lifetime in seconds.',
        schema: () => int(60, 3600),
        fromConfig: (config) => config.auth.accessTtlSeconds,
    }),
    'auth.refresh_ttl_seconds': define({
        description: 'Refresh token lifetime in seconds.',
        schema: () => int(3600, 7_776_000),
        fromConfig: (config) => config.auth.refreshTtlSeconds,
    }),
    'otp.length': define({
        description: 'Digits in a one-time code.',
        schema: () => int(4, 10),
        fromConfig: (config) => config.otp.length,
    }),
    'otp.ttl_seconds': define({
        description: 'How long a one-time code stays valid, in seconds.',
        schema: () => int(60, 1800),
        fromConfig: (config) => config.otp.ttlSeconds,
    }),
    'otp.max_attempts': define({
        description: 'Guesses allowed per one-time code.',
        schema: () => int(1, 10),
        fromConfig: (config) => config.otp.maxAttempts,
    }),
    'throttle.ttl_seconds': define({
        description: 'Rate limit window in seconds.',
        schema: () => int(1, 3600),
        fromConfig: (config) => config.throttle.ttlSeconds,
    }),
    'throttle.limit': define({
        description: 'Requests per window to sign-in endpoints, per address and per phone.',
        schema: () => int(1, 1000),
        fromConfig: (config) => config.throttle.limit,
    }),
    'throttle.global_limit': define({
        description: 'Requests per window to any endpoint, per address or user.',
        schema: () => int(10, 100_000),
        fromConfig: (config) => config.throttle.globalLimit,
    }),
    'throttle.upload_limit': define({
        description: 'Image uploads per window.',
        schema: () => int(1, 1000),
        fromConfig: (config) => config.throttle.uploadLimit,
    }),
    'sms.hourly_limit': define({
        description: 'SMS sent per hour across the whole system; 0 means no limit.',
        schema: () => z.number().int().min(0),
        fromConfig: (config) => config.sms.budget.hourlyLimit,
    }),
    'sms.daily_limit': define({
        description: 'SMS sent per day across the whole system; 0 means no limit.',
        schema: () => z.number().int().min(0),
        fromConfig: (config) => config.sms.budget.dailyLimit,
    }),
    'viber.enabled': define({
        description:
            'Send client notifications that would go by SMS through Viber instead; needs VIBER_PROVIDER.',
        schema: (config) =>
            config.viber.provider === 'none'
                ? z.literal(false, { error: 'VIBER_PROVIDER is not configured' })
                : z.boolean(),
        fromConfig: () => false,
    }),
    'viber.sms_fallback': define({
        description: 'Let the provider fall back to SMS when a Viber message is not delivered.',
        schema: () => z.boolean(),
        fromConfig: () => true,
    }),
    'upload.max_bytes': define({
        description: 'Largest accepted image in bytes; UPLOAD_MAX_BYTES in the environment is the ceiling.',
        schema: (config) => int(UPLOAD_MIN_BYTES, config.upload.maxBytes),
        fromConfig: (config) => config.upload.maxBytes,
    }),
    'upload.allowed_mime': define({
        description: 'Image types accepted for upload.',
        schema: () =>
            z
                .array(z.enum(UPLOAD_MIME_TYPES))
                .min(1)
                .refine((list) => new Set(list).size === list.length, 'Must not repeat a type'),
        fromConfig: (config) => config.upload.allowedMime,
    }),
    'bookings.reminder_hours': define({
        description: 'How many hours ahead a booking reminder is sent.',
        schema: () => int(1, 168),
        fromConfig: (config) => config.bookings.reminderHours,
    }),
    'retention.service_trash_days': define({
        description: 'Days a deleted service stays restorable before it is purged.',
        schema: () => int(1, 365),
        fromConfig: (config) => config.retention.serviceTrashDays,
    }),
    'retention.recurrent_horizon_days': define({
        description: 'Days ahead recurrent slots are generated.',
        schema: () => int(7, 365),
        fromConfig: (config) => config.retention.recurrentHorizonDays,
    }),
    'site.default_currency': define({
        description: 'ISO 4217 currency used when a price is set without one.',
        schema: () => z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code like EUR'),
        fromConfig: (config) => config.site.defaultCurrency,
    }),
    'jobs.report_recipients': define({
        description: 'E-mail addresses that receive the scheduled reports.',
        schema: () => z.array(emailSchema).max(REPORT_RECIPIENTS_MAX),
        fromConfig: (config) => config.jobs.reportRecipients,
    }),
};

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = ReturnType<(typeof SETTINGS)[K]['fromConfig']>;
export type SettingsValues = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(value: string): value is SettingKey {
    return Object.hasOwn(SETTINGS, value);
}

export function groupOf(key: SettingKey): string {
    return key.slice(0, key.indexOf('.'));
}

interface CrossRule {
    path: SettingKey;
    keys: SettingKey[];
    message: string;
    holds: (values: SettingsValues) => boolean;
}

export const CROSS_RULES: CrossRule[] = [
    {
        path: 'auth.lockout_max_seconds',
        keys: ['auth.lockout_max_seconds', 'auth.lockout_seconds'],
        message: 'Must not be below auth.lockout_seconds',
        holds: (values) => values['auth.lockout_max_seconds'] >= values['auth.lockout_seconds'],
    },
    {
        path: 'auth.failed_attempt_window_seconds',
        keys: ['auth.failed_attempt_window_seconds', 'auth.lockout_seconds'],
        message: 'Must not be below auth.lockout_seconds',
        holds: (values) => values['auth.failed_attempt_window_seconds'] >= values['auth.lockout_seconds'],
    },
    {
        path: 'throttle.global_limit',
        keys: ['throttle.global_limit', 'throttle.limit'],
        message: 'Must not be below throttle.limit',
        holds: (values) => values['throttle.global_limit'] >= values['throttle.limit'],
    },
    {
        path: 'sms.daily_limit',
        keys: ['sms.daily_limit', 'sms.hourly_limit'],
        message: 'Must not be below sms.hourly_limit',
        holds: (values) =>
            values['sms.daily_limit'] === 0 ||
            values['sms.hourly_limit'] === 0 ||
            values['sms.daily_limit'] >= values['sms.hourly_limit'],
    },
];

export function crossRuleViolations(
    after: SettingsValues,
    before?: SettingsValues,
    changed: SettingKey[] = [],
): ApiErrorDetail[] {
    return CROSS_RULES.filter(
        (rule) =>
            !rule.holds(after) &&
            (!before || rule.holds(before) || rule.keys.some((key) => changed.includes(key))),
    ).map(({ path, message }) => ({ path, message }));
}
