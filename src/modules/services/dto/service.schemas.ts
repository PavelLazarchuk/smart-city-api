import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    dateOnlySchema,
    enabledSchema,
    idOutputSchema,
    isoDateTimeSchema,
    labelSchema,
    objectIdSchema,
    positionSchema,
    timeOfDaySchema,
    timestampsOutputSchema,
    urlSchema,
    uuidSchema,
} from '../../../common/zod/primitives';
import { SERVICE_TYPES, SLOT_TYPES, WEEKDAYS } from '../schemas/service.schema';

const text = z.string().trim().max(5000);
const limitSchema = z.number().int().min(0).nullable();

// ----- bookings (output) -----

/**
 * Output schemas validate stored data, so their string checks are structural only: a legacy row with a
 * malformed e-mail or date must serialize, not 500. Format is enforced by the input schemas below.
 */
const outputText = z.string();

/** Full booking, visible to the organization's admins and super-admins. */
export const bookingResponseSchema = z.object({
    id: z.string(),
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    info: z.string().catch(''),
    created_at: isoDateTimeSchema,
});

/** Anonymised booking for everyone else. */
export const maskedBookingSchema = z.object({ status: z.literal('reserved') });

const bookingsOutput = z.array(z.union([bookingResponseSchema, maskedBookingSchema]));
/**
 * Public routes serialize through this instead: the union above would happily pass a full booking, so a
 * forgotten `masker.mask()` would be the only thing standing between a client and leaked PII.
 */
const maskedBookingsOutput = z.array(maskedBookingSchema);

// ----- slots -----

const timeEntryInput = z.object({ time: timeOfDaySchema, limit: limitSchema.optional() });
const timeEntryOutput = (bookings: z.ZodType) =>
    z.object({
        time: outputText,
        limit: limitSchema.catch(null),
        booked_count: z.number().int().min(0).catch(0),
        bookings,
    });

const infoValue = z.object({
    description: text.optional(),
    link: urlSchema.optional(),
    price: text.optional(),
});

const infoValueOutput = z.object({
    description: outputText.optional(),
    link: outputText.optional(),
    price: outputText.optional(),
});

/** Input never carries bookings or counters — those are server-owned. */
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
        child_type: z.literal('delivery'),
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

const slotResponseSchemaFor = (bookings: z.ZodType) =>
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
            child_type: z.literal('delivery'),
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

// ----- options -----

export const recurrentDateSchema = z.object({
    day: z.enum(WEEKDAYS),
    time: z.array(z.object({ time: timeOfDaySchema, limit: limitSchema.optional() })).max(200),
});

export const serviceOptionInputSchema = z.object({
    id: uuidSchema.optional(),
    label: labelSchema.optional(),
    service_type: z.enum(SERVICE_TYPES).optional(),
    enabled: enabledSchema.optional(),
    recurrent_dates: z.array(recurrentDateSchema).max(7).nullable().optional(),
    slots: z.array(slotInputSchema).max(500).optional(),
});
export type ServiceOptionInput = z.infer<typeof serviceOptionInputSchema>;

const serviceOptionResponseSchemaFor = (bookings: z.ZodType) =>
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
                }),
            )
            .optional(),
        slots: z.array(slotResponseSchemaFor(bookings)),
    });

export const serviceOptionResponseSchema = serviceOptionResponseSchemaFor(bookingsOutput);

// ----- service -----

export const serviceContentInputSchema = z.object({
    heading_label: text.optional(),
    heading_value: text.optional(),
    text_label: text.optional(),
    text_value: text.optional(),
    image_label: text.optional(),
    image_value: text.optional(),
    price_label: text.optional(),
    price_value: text.optional(),
    link_label: text.optional(),
    link_value: text.optional(),
    subscribe: z.email().optional(),
});

export const serviceContentResponseSchema = z.object({
    heading_label: outputText.optional(),
    heading_value: outputText.optional(),
    text_label: outputText.optional(),
    text_value: outputText.optional(),
    image_label: outputText.optional(),
    image_value: outputText.optional(),
    price_label: outputText.optional(),
    price_value: outputText.optional(),
    link_label: outputText.optional(),
    link_value: outputText.optional(),
    subscribe: outputText.optional(),
});

const serviceResponseSchemaFor = (bookings: z.ZodType) =>
    z.object({
        id: idOutputSchema,
        organization_id: idOutputSchema,
        category_id: idOutputSchema.nullable(),
        position: positionSchema.catch(0),
        label: z.string(),
        enabled: enabledSchema,
        value: serviceContentResponseSchema,
        options: z.array(serviceOptionResponseSchemaFor(bookings)),
        ...timestampsOutputSchema,
    });

export const serviceResponseSchema = serviceResponseSchemaFor(bookingsOutput);
export class ServiceResponseDto extends createZodDto(serviceResponseSchema) {}

export const maskedServiceResponseSchema = serviceResponseSchemaFor(maskedBookingsOutput);
export class MaskedServiceResponseDto extends createZodDto(maskedServiceResponseSchema) {}

export const createServiceSchema = z.object({
    organization_id: objectIdSchema,
    category_id: objectIdSchema.nullable().optional(),
    label: labelSchema.optional(),
    enabled: enabledSchema.optional(),
    value: serviceContentInputSchema.optional(),
    options: z.array(serviceOptionInputSchema).max(50).optional(),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export class CreateServiceDto extends createZodDto(createServiceSchema) {}

export const updateServiceSchema = z
    .object({
        category_id: objectIdSchema.nullable(),
        label: labelSchema,
        enabled: enabledSchema,
        value: serviceContentInputSchema,
        options: z.array(serviceOptionInputSchema).max(50),
    })
    .partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export class UpdateServiceDto extends createZodDto(updateServiceSchema) {}

export const listServicesQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    category_id: objectIdSchema.optional(),
    enabled: z.stringbool().optional(),
});
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
export class ListServicesQueryDto extends createZodDto(listServicesQuerySchema) {}

// ----- bookings (input) -----

export const createBookingSchema = z.object({
    option_id: uuidSchema,
    slot_id: uuidSchema,
    time: timeOfDaySchema.optional(),
    info: z.string().trim().max(1000).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export class CreateBookingDto extends createZodDto(createBookingSchema) {}

export const bookingCreatedResponseSchema = z.object({
    booking_id: uuidSchema,
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    option_id: z.string(),
    slot_id: z.string(),
    child_type: z.enum(SLOT_TYPES),
    date: outputText.optional(),
    time: outputText.optional(),
    created_at: isoDateTimeSchema,
});
export type BookingCreated = z.infer<typeof bookingCreatedResponseSchema>;
export class BookingCreatedResponseDto extends createZodDto(bookingCreatedResponseSchema) {}
