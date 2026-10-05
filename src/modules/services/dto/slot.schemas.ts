import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SERVICE_TYPES, SLOT_TYPES } from '../schemas/service.schema';
import {
    dateOnlySchema,
    enabledSchema,
    idOutputSchema,
    isoDateTimeSchema,
    labelSchema,
    richTextSchema,
    timeOfDaySchema,
    urlSchema,
    uuidSchema,
} from '../../../common/zod/primitives';

export const text = z.string().trim().max(5000);
export const limitSchema = z.number().int().min(0).nullable();

export const outputText = z.string();

export const bookingResponseSchema = z.object({
    id: z.string(),
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    info: z.string().catch(''),
    time: z.string().nullable().optional().catch(null),
    end_time: z.string().nullable().optional().catch(null),
    address: z.string().nullable().optional().catch(null),
    status: z.string().catch('confirmed'),
    created_at: isoDateTimeSchema,
});

export const maskedBookingSchema = z.object({ status: z.literal('reserved') });

export const bookingsOutput = z.array(z.union([bookingResponseSchema, maskedBookingSchema])).default([]);
export const maskedBookingsOutput = z.array(maskedBookingSchema).default([]);

const timeEntryInput = z.object({ time: timeOfDaySchema, limit: limitSchema.optional() });
const timeEntryOutput = (bookings: z.ZodType) =>
    z.object({
        time: outputText,
        limit: limitSchema.catch(null),
        booked_count: z.number().int().min(0).catch(0),
        bookings,
    });

export const minutesSchema = z
    .number()
    .int()
    .min(1)
    .max(24 * 60);

const callbackEntryInput = z
    .object({ time: timeOfDaySchema, to: timeOfDaySchema, limit: limitSchema.optional() })
    .refine((entry) => entry.time < entry.to, { message: 'time must be before to', path: ['to'] });

const callbackEntryOutput = (bookings: z.ZodType) =>
    z.object({
        time: outputText,
        to: outputText,
        limit: limitSchema.catch(null),
        booked_count: z.number().int().min(0).catch(0),
        bookings,
    });

const rangeValueInput = z
    .object({
        date: dateOnlySchema,
        from: timeOfDaySchema.optional(),
        to: timeOfDaySchema.optional(),
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

const infoValue = z.object({
    description: richTextSchema(5000).optional(),
    link: urlSchema.optional(),
    price: text.optional(),
});

const infoValueOutput = z.object({
    description: outputText.optional(),
    link: outputText.optional(),
    price: outputText.optional(),
});

export const slotInputSchema = z.discriminatedUnion('child_type', [
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('date_time'),
        value: z.object({ date: dateOnlySchema, time: z.array(timeEntryInput).max(200) }),
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('date'),
        value: z.object({ date: dateOnlySchema, limit: limitSchema.optional() }),
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('apply'),
        value: z.object({ limit: limitSchema.optional() }),
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('time_range'),
        value: rangeValueInput,
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('callback'),
        value: z.object({
            date: dateOnlySchema,
            time: z
                .array(callbackEntryInput)
                .max(200)
                .refine((entries) => new Set(entries.map((entry) => entry.time)).size === entries.length, {
                    message: 'Times must be unique',
                }),
        }),
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('pickup'),
        value: infoValue,
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('courier'),
        value: infoValue,
    }),
    z.object({
        id: uuidSchema.optional(),
        label: labelSchema.optional(),
        child_type: z.literal('paycard'),
        value: infoValue,
    }),
]);
export type SlotInput = z.infer<typeof slotInputSchema>;

export const slotResponseSchemaFor = (bookings: z.ZodType) =>
    z.discriminatedUnion('child_type', [
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('date_time'),
            value: z.object({ date: outputText, time: z.array(timeEntryOutput(bookings)) }),
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('date'),
            value: z.object({
                date: outputText,
                limit: limitSchema.catch(null),
                booked_count: z.number().int().min(0).catch(0),
                bookings,
            }),
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('apply'),
            value: z.object({
                limit: limitSchema.catch(null),
                booked_count: z.number().int().min(0).catch(0),
                bookings,
            }),
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('time_range'),
            value: z.object({
                date: outputText,
                resource: outputText.optional(),
                from: outputText,
                to: outputText,
                step_minutes: z.number().int(),
                min_minutes: z.number().int(),
                max_minutes: z.number().int().nullable().catch(null),
                booked_count: z.number().int().min(0).catch(0),
                bookings,
            }),
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('callback'),
            value: z.object({ date: outputText, time: z.array(callbackEntryOutput(bookings)) }),
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('pickup'),
            value: infoValueOutput,
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('courier'),
            value: infoValueOutput,
        }),
        z.object({
            id: z.string(),
            label: z.string(),
            child_type: z.literal('paycard'),
            value: infoValueOutput,
        }),
    ]);

export const slotResponseSchema = slotResponseSchemaFor(bookingsOutput);

export const createSlotSchema = slotInputSchema;

export const updateSlotSchema = z
    .object({
        label: labelSchema,
        date: dateOnlySchema,
        limit: limitSchema,
        time: z
            .array(
                z
                    .object({
                        time: timeOfDaySchema,
                        to: timeOfDaySchema.optional(),
                        limit: limitSchema.optional(),
                    })
                    .refine((entry) => entry.to === undefined || entry.time < entry.to, {
                        message: 'time must be before to',
                        path: ['to'],
                    }),
            )
            .max(200),
        from: timeOfDaySchema,
        to: timeOfDaySchema,
        step_minutes: minutesSchema,
        min_minutes: minutesSchema,
        max_minutes: minutesSchema.nullable(),
    })
    .partial();
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>;
export class UpdateSlotDto extends createZodDto(updateSlotSchema) {}

export const closeSlotSchema = z.object({
    time: timeOfDaySchema.optional(),
    reason: z.string().trim().max(500).optional(),
    remove: z.boolean().optional(),
    notify: z.boolean().optional(),
});
export type CloseSlotInput = z.infer<typeof closeSlotSchema>;
export class CloseSlotDto extends createZodDto(closeSlotSchema) {}

export const closeSlotResponseSchema = z.object({
    service_id: idOutputSchema,
    option_id: z.string(),
    slot_id: z.string(),
    time: outputText.nullable(),
    cancelled: z.number().int().min(0),
    waitlist_dropped: z.number().int().min(0),
    notifications_queued: z.number().int().min(0),
    removed: z.boolean(),
});
export type CloseSlotResult = z.infer<typeof closeSlotResponseSchema>;
export class CloseSlotResponseDto extends createZodDto(closeSlotResponseSchema) {}

export const moveSlotSchema = z.object({
    date: dateOnlySchema,
    shift_minutes: z
        .number()
        .int()
        .min(-(24 * 60 - 1))
        .max(24 * 60 - 1)
        .optional(),
    reason: z.string().trim().max(500).optional(),
    notify: z.boolean().optional(),
});
export type MoveSlotInput = z.infer<typeof moveSlotSchema>;
export class MoveSlotDto extends createZodDto(moveSlotSchema) {}

export const moveSlotResponseSchema = z.object({
    service_id: idOutputSchema,
    option_id: z.string(),
    slot_id: z.string(),
    date: outputText,
    previous_date: outputText,
    moved: z.number().int().min(0),
    notifications_queued: z.number().int().min(0),
});
export type MoveSlotResult = z.infer<typeof moveSlotResponseSchema>;
export class MoveSlotResponseDto extends createZodDto(moveSlotResponseSchema) {}

export const availabilityQuerySchema = z.object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export class AvailabilityQueryDto extends createZodDto(availabilityQuerySchema) {}

const availabilityTimeSchema = z.object({
    time: outputText,
    limit: limitSchema,
    booked_count: z.number().int().min(0),
    available: z.number().int().min(0).nullable(),
});

const availabilitySlotSchema = z.object({
    id: z.string(),
    label: z.string(),
    child_type: z.enum(SLOT_TYPES),
    date: outputText.nullable(),
    limit: limitSchema,
    booked_count: z.number().int().min(0),
    available: z.number().int().min(0).nullable(),
    time: z.array(availabilityTimeSchema.extend({ to: outputText.optional() })).optional(),
    range: z
        .object({
            from: outputText,
            to: outputText,
            step_minutes: z.number().int(),
            min_minutes: z.number().int(),
            max_minutes: z.number().int().nullable(),
            free: z.array(z.object({ from: outputText, to: outputText })),
        })
        .optional(),
});

export const availabilityResponseSchema = z.object({
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    from: outputText,
    to: outputText,
    options: z.array(
        z.object({
            id: z.string(),
            label: z.string(),
            service_type: z.enum(SERVICE_TYPES),
            enabled: enabledSchema,
            slots: z.array(availabilitySlotSchema),
        }),
    ),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
export class AvailabilityResponseDto extends createZodDto(availabilityResponseSchema) {}

export const serviceSlotsQuerySchema = z.object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    after: isoDateTimeSchema.optional(),
    before: isoDateTimeSchema.optional(),
    option_id: uuidSchema.optional(),
    only_available: z.stringbool().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type ServiceSlotsQuery = z.infer<typeof serviceSlotsQuerySchema>;
export class ServiceSlotsQueryDto extends createZodDto(serviceSlotsQuerySchema) {}

export const slotCandidateSchema = z.object({
    option_id: z.string(),
    option_label: z.string(),
    service_type: z.enum(SERVICE_TYPES),
    slot_id: z.string(),
    slot_label: z.string(),
    child_type: z.enum(SLOT_TYPES),
    date: outputText.nullable(),
    time: outputText.nullable(),
    starts_at: isoDateTimeSchema.nullable(),
    ends_at: isoDateTimeSchema.nullable(),
    limit: limitSchema,
    booked_count: z.number().int().min(0),
    available: z.number().int().min(0).nullable(),
    range: z
        .object({
            step_minutes: minutesSchema,
            min_minutes: minutesSchema,
            max_minutes: minutesSchema.nullable(),
        })
        .optional(),
});
export type SlotCandidate = z.infer<typeof slotCandidateSchema>;

export const serviceSlotsResponseSchema = z.object({
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    timezone: z.string(),
    from: outputText,
    to: outputText,
    total: z.number().int().min(0),
    items: z.array(slotCandidateSchema),
});
export type ServiceSlotsResponse = z.infer<typeof serviceSlotsResponseSchema>;
export class ServiceSlotsResponseDto extends createZodDto(serviceSlotsResponseSchema) {}
