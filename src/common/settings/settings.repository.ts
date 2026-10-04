import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Settings, SETTINGS_DOCUMENT_ID } from './schemas/settings.schema';

const DUPLICATE_KEY = 11000;

export interface SettingsRow {
    settings: Record<string, unknown>;
    updated_at: Date | null;
}

export interface SettingsWrite {
    expected: Date | null;
    set: Record<string, unknown>;
    unset: string[];
    now: Date;
}

@Injectable()
export class SettingsRepository {
    constructor(@InjectModel(Settings.name) private readonly model: Model<Settings>) {}

    async read(): Promise<SettingsRow | null> {
        const row = await this.model
            .findById(SETTINGS_DOCUMENT_ID)
            .lean<{ settings?: Record<string, unknown>; updated_at?: Date | null }>()
            .exec();

        return row ? { settings: row.settings ?? {}, updated_at: row.updated_at ?? null } : null;
    }

    async stamp(): Promise<Date | null> {
        const row = await this.model
            .findById(SETTINGS_DOCUMENT_ID, { updated_at: 1 })
            .lean<{ updated_at?: Date | null }>()
            .exec();

        return row?.updated_at ?? null;
    }

    async write({ expected, set, unset, now }: SettingsWrite): Promise<boolean> {
        const update: Record<string, unknown> = { $set: { ...set, updated_at: now } };

        if (unset.length > 0) update['$unset'] = Object.fromEntries(unset.map((path) => [path, '']));

        try {
            const result = await this.model.collection.updateOne(
                { _id: SETTINGS_DOCUMENT_ID, updated_at: expected },
                update,
                { upsert: true },
            );

            return result.matchedCount > 0 || result.upsertedCount > 0;
        } catch (error) {
            if ((error as { code?: number }).code === DUPLICATE_KEY) return false;

            throw error;
        }
    }
}
