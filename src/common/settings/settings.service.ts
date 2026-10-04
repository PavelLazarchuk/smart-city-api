import { HttpStatus, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { AppConfig } from '../config/app-config';
import { type AuthUser } from '../decorators/current-user.decorator';
import { ApiError, type ApiErrorDetail } from '../http/api-error';
import { MetricsService } from '../metrics/metrics.service';
import { type SettingResource, type SettingsResource, type SettingsWarning } from './dto/settings.schemas';
import {
    crossRuleViolations,
    groupOf,
    isSettingKey,
    SETTING_KEYS,
    type SettingKey,
    SETTINGS,
    SETTINGS_REFRESH_MS,
    type SettingsValues,
    type SettingValue,
} from './settings.registry';
import { SettingsRepository, type SettingsRow } from './settings.repository';

export interface SettingsChange {
    before: SettingsValues;
    after: SettingsValues;
    changed: SettingKey[];
}

export type SettingsWriteCheck = (change: SettingsChange, actor: AuthUser) => Promise<SettingsWarning[]>;

interface Snapshot {
    overrides: Map<SettingKey, unknown>;
    stale: string[];
    updatedAt: Date | null;
}

const EMPTY: Snapshot = { overrides: new Map(), stale: [], updatedAt: null };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function settingLockoutRisk(details: ApiErrorDetail[]): ApiError {
    return new ApiError(HttpStatus.CONFLICT, 'SETTING_LOCKOUT_RISK', details);
}

export function settingsTag(updatedAt: Date | null): string {
    return `"${updatedAt ? updatedAt.getTime() : 0}"`;
}

function parseTag(header: string | undefined): string | undefined {
    if (header === undefined || header.trim() === '' || header.trim() === '*') return undefined;

    return header.trim().replace(/^W\//, '');
}

@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
    private snapshot: Snapshot = EMPTY;
    private timer: NodeJS.Timeout | undefined;
    private readonly checks: { name: string; check: SettingsWriteCheck }[] = [];
    private readonly schemas: Record<SettingKey, z.ZodType>;
    private readonly jsonSchemas: Record<SettingKey, Record<string, unknown>>;

    constructor(
        private readonly repository: SettingsRepository,
        private readonly config: AppConfig,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(SettingsService.name);
        this.schemas = Object.fromEntries(
            SETTING_KEYS.map((key) => [key, SETTINGS[key].schema(config)]),
        ) as Record<SettingKey, z.ZodType>;
        this.jsonSchemas = Object.fromEntries(
            SETTING_KEYS.map((key) => {
                const schema: Record<string, unknown> = {
                    ...z.toJSONSchema(this.schemas[key], { io: 'input', unrepresentable: 'any' }),
                };
                delete schema['$schema'];

                return [key, schema];
            }),
        ) as Record<SettingKey, Record<string, unknown>>;
    }

    async onModuleInit(): Promise<void> {
        if (this.config.settings.ignoreDb) {
            this.logger.warn('SETTINGS_IGNORE_DB is set: runtime settings come from the environment only');

            return;
        }

        this.apply(await this.repository.read());
        this.timer = setInterval(() => void this.poll(), SETTINGS_REFRESH_MS);
        this.timer.unref();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
    }

    get<K extends SettingKey>(key: K): SettingValue<K> {
        const { overrides } = this.snapshot;

        return (
            overrides.has(key) ? overrides.get(key) : SETTINGS[key].fromConfig(this.config)
        ) as SettingValue<K>;
    }

    registerWriteCheck(name: string, check: SettingsWriteCheck): void {
        this.checks.push({ name, check });
    }

    async refresh(): Promise<void> {
        if (this.config.settings.ignoreDb) return;

        this.apply(await this.repository.read());
    }

    list(): SettingsResource {
        return {
            updated_at: this.snapshot.updatedAt?.toISOString() ?? null,
            items: SETTING_KEYS.map((key) => this.resource(key)),
        };
    }

    getOne(rawKey: string): SettingResource {
        return this.resource(this.key(rawKey));
    }

    get tag(): string {
        return settingsTag(this.snapshot.updatedAt);
    }

    async update(
        values: Record<string, unknown>,
        ifMatch: string | undefined,
        actor: AuthUser,
    ): Promise<SettingsResource> {
        const details: ApiErrorDetail[] = [];
        const changes = new Map<SettingKey, unknown>();

        for (const [key, value] of Object.entries(values)) {
            if (!isSettingKey(key)) {
                details.push({ path: key, message: 'Unknown setting' });
                continue;
            }

            const parsed = this.schemas[key].safeParse(value);

            if (parsed.success) changes.set(key, parsed.data);
            else
                details.push(
                    ...parsed.error.issues.map((issue) => ({
                        path: [key, ...issue.path].join('.'),
                        message: issue.message,
                    })),
                );
        }

        if (details.length > 0) throw ApiError.unprocessable('SETTINGS_INVALID', details);

        const warnings = await this.write(changes, ifMatch, actor);

        return warnings.length > 0 ? { ...this.list(), warnings } : this.list();
    }

    async reset(rawKey: string, ifMatch: string | undefined, actor: AuthUser): Promise<SettingsResource> {
        const warnings = await this.write(new Map([[this.key(rawKey), null]]), ifMatch, actor);

        return warnings.length > 0 ? { ...this.list(), warnings } : this.list();
    }

    private async write(
        changes: Map<SettingKey, unknown>,
        ifMatch: string | undefined,
        actor: AuthUser,
    ): Promise<SettingsWarning[]> {
        if (this.config.settings.ignoreDb) throw ApiError.conflict('SETTINGS_READ_ONLY');

        const current = this.build(await this.repository.read());
        const expectedTag = parseTag(ifMatch);

        if (expectedTag !== undefined && expectedTag !== settingsTag(current.updatedAt))
            throw ApiError.conflict('SETTINGS_CONFLICT');

        const overrides = new Map(current.overrides);

        for (const [key, value] of changes) {
            if (value === null) overrides.delete(key);
            else overrides.set(key, value);
        }

        const change: SettingsChange = {
            before: this.values(current.overrides),
            after: this.values(overrides),
            changed: [...changes.keys()],
        };
        const violations = crossRuleViolations(change.after, change.before, change.changed);

        if (violations.length > 0) throw ApiError.unprocessable('SETTINGS_INVALID', violations);

        const warnings: SettingsWarning[] = [];

        for (const { check } of this.checks) warnings.push(...(await check(change, actor)));

        const { set, unset, cleared } = this.diff(current, changes, overrides);

        if (Object.keys(set).length === 0 && unset.length === 0) {
            this.snapshot = current;

            return warnings;
        }

        const now = new Date(Math.max(Date.now(), (current.updatedAt?.getTime() ?? 0) + 1));
        const written = await this.repository.write({ expected: current.updatedAt, now, set, unset });

        if (!written) throw ApiError.conflict('SETTINGS_CONFLICT');

        this.snapshot = {
            overrides,
            stale: current.stale.filter((path) => !cleared.has(path)),
            updatedAt: now,
        };
        this.metrics.markSettingsRefreshed();
        this.logger.info({ actor_id: actor.id, keys: change.changed }, 'runtime settings changed');

        return warnings;
    }

    private diff(
        current: Snapshot,
        changes: Map<SettingKey, unknown>,
        overrides: Map<SettingKey, unknown>,
    ): { set: Record<string, unknown>; unset: string[]; cleared: Set<string> } {
        const set: Record<string, unknown> = {};
        const unset: string[] = [];
        const cleared = new Set<string>();
        const brokenGroups = new Map<string, Record<string, unknown>>();
        const emptiedGroups = new Set<string>();

        for (const [key, value] of changes) {
            const group = groupOf(key);
            const path = `settings.${key}`;

            if (current.stale.includes(`settings.${group}`)) {
                const entries = brokenGroups.get(group) ?? {};

                if (value !== null) entries[key.slice(group.length + 1)] = value;

                brokenGroups.set(group, entries);
            } else if (value === null) {
                if (current.overrides.has(key) || current.stale.includes(path)) {
                    unset.push(path);
                    cleared.add(path);
                    emptiedGroups.add(group);
                }
            } else if (JSON.stringify(current.overrides.get(key)) !== JSON.stringify(value)) {
                set[path] = value;
                cleared.add(path);
            }
        }

        for (const [group, entries] of brokenGroups) {
            if (Object.keys(entries).length > 0) set[`settings.${group}`] = entries;
            else unset.push(`settings.${group}`);

            cleared.add(`settings.${group}`);
        }

        for (const group of emptiedGroups) {
            const prefix = `settings.${group}.`;
            const remains =
                [...overrides.keys()].some((key) => groupOf(key) === group) ||
                current.stale.some((path) => path.startsWith(prefix) && !cleared.has(path));

            if (!remains) {
                const kept = unset.filter((path) => !path.startsWith(prefix));

                unset.splice(0, unset.length, ...kept, `settings.${group}`);
            }
        }

        return { set, unset, cleared };
    }

    private async poll(): Promise<void> {
        try {
            const stamp = await this.repository.stamp();

            if ((stamp?.getTime() ?? null) !== (this.snapshot.updatedAt?.getTime() ?? null)) {
                const row = await this.repository.read();
                const known = this.snapshot.updatedAt?.getTime() ?? 0;

                if (!row?.updated_at || row.updated_at.getTime() >= known) this.apply(row);
            }

            this.metrics.markSettingsRefreshed();
        } catch (error) {
            this.logger.warn({ err: error }, 'runtime settings refresh failed, keeping the last snapshot');
        }
    }

    private apply(row: SettingsRow | null): void {
        this.snapshot = this.build(row);
        this.metrics.markSettingsRefreshed();

        for (const path of this.snapshot.stale)
            this.logger.warn(
                { path },
                'runtime setting ignored: unknown key or invalid value, using the environment',
            );
    }

    private build(row: SettingsRow | null): Snapshot {
        if (!row) return EMPTY;

        const overrides = new Map<SettingKey, unknown>();
        const stale: string[] = [];

        for (const [group, entries] of Object.entries(row.settings)) {
            if (!isRecord(entries)) {
                stale.push(`settings.${group}`);
                continue;
            }

            for (const [name, value] of Object.entries(entries)) {
                const key = `${group}.${name}`;
                const parsed = isSettingKey(key) ? this.schemas[key].safeParse(value) : undefined;

                if (isSettingKey(key) && parsed?.success) overrides.set(key, parsed.data);
                else stale.push(`settings.${key}`);
            }
        }

        return { overrides, stale, updatedAt: row.updated_at };
    }

    private values(overrides: Map<SettingKey, unknown>): SettingsValues {
        return Object.fromEntries(
            SETTING_KEYS.map((key) => [
                key,
                overrides.has(key) ? overrides.get(key) : SETTINGS[key].fromConfig(this.config),
            ]),
        ) as SettingsValues;
    }

    private resource(key: SettingKey): SettingResource {
        const overridden = this.snapshot.overrides.has(key);

        return {
            key,
            group: groupOf(key),
            value: this.get(key),
            source: overridden ? 'db' : 'env',
            env_value: SETTINGS[key].fromConfig(this.config),
            schema: this.jsonSchemas[key],
            description: SETTINGS[key].description,
        };
    }

    private key(raw: string): SettingKey {
        if (!isSettingKey(raw)) throw ApiError.notFound('SETTING_NOT_FOUND');

        return raw;
    }
}
