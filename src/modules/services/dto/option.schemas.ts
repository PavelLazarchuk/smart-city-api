import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SERVICE_TYPES, WEEKDAYS } from '../schemas/service.schema';
import {
    bookingsOutput,
    limitSchema,
    minutesSchema,
    outputText,
    slotInputSchema,
    slotResponseSchemaFor,
} from './slot.schemas';
import { enabledSchema, labelSchema, timeOfDaySchema, uuidSchema } from '../../../common/zod/primitives';

export const recurrentDateSchema = z.object({
    day: z.enum(WEEKDAYS),
    time: z
        .array(z.object({ time: timeOfDaySchema, limit: limitSchema.optional() }))
        .max(200)
        .default([]),
    limit: limitSchema.optional(),
});

export const recurrentRangeSchema = z
    .object({
        day: z.enum(WEEKDAYS),
        from: timeOfDaySchema.optional(),
        to: timeOfDaySchema.optional(),
        resources: z
            .array(z.string().trim().min(1).max(100))
            .min(1)
            .max(50)
            .refine((items) => new Set(items).size === items.length, { message: 'Resources must be unique' }),
        step_minutes: minutesSchema.optional(),
        min_minutes: minutesSchema.optional(),
        max_minutes: minutesSchema.nullable().optional(),
    })
    .refine((value) => (value.from === undefined) === (value.to === undefined), {
        message: 'from and to go together',
        path: ['to'],
    })
    .refine((value) => value.from === undefined || value.to === undefined || value.from < value.to, {
        message: 'from must be before to',
        path: ['to'],
    })
    .refine(
        (value) =>
            value.min_minutes === undefined ||
            value.max_minutes === undefined ||
            value.max_minutes === null ||
            value.min_minutes <= value.max_minutes,
        { message: 'min_minutes must not exceed max_minutes', path: ['max_minutes'] },
    );

export type RecurrentRangeInput = z.infer<typeof recurrentRangeSchema>;

const recurrentRangesSchema = z
    .array(recurrentRangeSchema)
    .max(50)
    .refine(
        (entries) => {
            const keys = entries.flatMap((entry) =>
                entry.resources.map((resource) => `${entry.day}|${resource}`),
            );

            return new Set(keys).size === keys.length;
        },
        { message: 'A resource can appear once per weekday' },
    );

export const serviceOptionInputSchema = z.object({
    id: uuidSchema.optional(),
    label: labelSchema.optional(),
    service_type: z.enum(SERVICE_TYPES).optional(),
    enabled: enabledSchema.optional(),
    recurrent_dates: z.array(recurrentDateSchema).max(7).nullable().optional(),
    recurrent_ranges: recurrentRangesSchema.nullable().optional(),
    slots: z.array(slotInputSchema).max(500).optional(),
});
export type ServiceOptionInput = z.infer<typeof serviceOptionInputSchema>;

export const serviceOptionResponseSchemaFor = (bookings: z.ZodType) =>
    z.object({
        id: z.string(),
        label: z.string(),
        service_type: z.enum(SERVICE_TYPES),
        enabled: enabledSchema,
        recurrent_dates: z
            .array(
                z.object({
                    day: z.enum(WEEKDAYS),
                    time: z.array(z.object({ time: outputText, limit: limitSchema.catch(null) })),
                    limit: limitSchema.catch(null).optional(),
                }),
            )
            .optional(),
        recurrent_ranges: z
            .array(
                z.object({
                    day: z.enum(WEEKDAYS),
                    from: outputText.optional(),
                    to: outputText.optional(),
                    resources: z.array(z.string()),
                    step_minutes: z.number().int().optional(),
                    min_minutes: z.number().int().optional(),
                    max_minutes: z.number().int().nullable().catch(null),
                }),
            )
            .optional(),
        slots: z.array(slotResponseSchemaFor(bookings)),
    });

export const serviceOptionResponseSchema = serviceOptionResponseSchemaFor(bookingsOutput);

export const updateOptionSchema = z
    .object({
        label: labelSchema,
        service_type: z.enum(SERVICE_TYPES),
        enabled: enabledSchema,
    })
    .partial();
export type UpdateOptionInput = z.infer<typeof updateOptionSchema>;
export class UpdateOptionDto extends createZodDto(updateOptionSchema) {}

export const createOptionSchema = serviceOptionInputSchema;
export class CreateOptionDto extends createZodDto(createOptionSchema) {}

export const recurrenceSchema = z
    .object({
        recurrent_dates: z.array(recurrentDateSchema).max(7).nullable().optional(),
        recurrent_ranges: recurrentRangesSchema.nullable().optional(),
    })
    .refine((value) => value.recurrent_dates !== undefined || value.recurrent_ranges !== undefined, {
        message: 'Send recurrent_dates, recurrent_ranges or both',
    });
export type RecurrenceInput = z.infer<typeof recurrenceSchema>;
export class RecurrenceDto extends createZodDto(recurrenceSchema) {}
