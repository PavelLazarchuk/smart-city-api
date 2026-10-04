import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isoDateTimeSchema } from '../../zod/primitives';

export const SETTING_SOURCES = ['db', 'env'] as const;

export const updateSettingsSchema = z.object({
    values: z
        .record(z.string(), z.unknown())
        .refine((values) => Object.keys(values).length > 0, 'Must change at least one setting'),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}

export const settingResourceSchema = z.object({
    key: z.string(),
    group: z.string(),
    value: z.unknown(),
    source: z.enum(SETTING_SOURCES),
    env_value: z.unknown(),
    schema: z.record(z.string(), z.unknown()),
    description: z.string(),
});
export type SettingResource = z.infer<typeof settingResourceSchema>;
export class SettingResourceDto extends createZodDto(settingResourceSchema) {}

export const settingsWarningSchema = z.object({
    code: z.string(),
    message: z.string(),
    user_ids: z.array(z.string()).optional(),
});
export type SettingsWarning = z.infer<typeof settingsWarningSchema>;

export const settingsResourceSchema = z.object({
    updated_at: isoDateTimeSchema.nullable(),
    items: z.array(settingResourceSchema),
    warnings: z.array(settingsWarningSchema).optional(),
});
export type SettingsResource = z.infer<typeof settingsResourceSchema>;
export class SettingsResourceDto extends createZodDto(settingsResourceSchema) {}
