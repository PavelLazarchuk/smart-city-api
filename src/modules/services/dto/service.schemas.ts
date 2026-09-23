import { type Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z, type ZodType } from 'zod';

import { type RequestWithUser } from '../../../common/decorators/current-user.decorator';
import { ROLES } from '../../../common/decorators/roles.decorator';
import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../../../common/slug';
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
import { REVISION_ACTIONS } from '../schemas/service-revision.schema';
import {
    FORM_FIELD_TYPES,
    SERVICE_STATUSES,
    SERVICE_TYPES,
    SLOT_TYPES,
    WEEKDAYS,
} from '../schemas/service.schema';

const text = z.string().trim().max(5000);
const limitSchema = z.number().int().min(0).nullable();

const outputText = z.string();

/** Full booking, visible to the organization's admins and super-admins. */
export const bookingResponseSchema = z.object({
    id: z.string(),
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    info: z.string().catch(''),
    status: z.string().catch('confirmed'),
    created_at: isoDateTimeSchema,
});

/** Anonymised booking for everyone else. */
export const maskedBookingSchema = z.object({ status: z.literal('reserved') });

const bookingsOutput = z.array(z.union([bookingResponseSchema, maskedBookingSchema])).default([]);
const maskedBookingsOutput = z.array(maskedBookingSchema).default([]);

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

export const recurrentDateSchema = z.object({
    day: z.enum(WEEKDAYS),
    time: z
        .array(z.object({ time: timeOfDaySchema, limit: limitSchema.optional() }))
        .max(200)
        .default([]),
    limit: limitSchema.optional(),
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
                    limit: limitSchema.catch(null).optional(),
                }),
            )
            .optional(),
        slots: z.array(slotResponseSchemaFor(bookings)),
    });

export const serviceOptionResponseSchema = serviceOptionResponseSchemaFor(bookingsOutput);

export const slugSchema = z.string().trim().toLowerCase().min(1).max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN);
const tagSchema = z.string().trim().min(1).max(50);
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code');
const monthDaySchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Must be MM-DD');
const fieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Must be snake_case');

export const workingHoursSchema = z
    .object({ day: z.enum(WEEKDAYS), from: timeOfDaySchema, to: timeOfDaySchema })
    .refine((entry) => entry.from < entry.to, { message: 'from must be before to', path: ['to'] });

export const geoPointInputSchema = z.object({
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
});

export const geoPointOutputSchema = z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
});

export const bookingPolicySchema = z.object({
    max_active_per_user: z.number().int().min(1).nullable().optional(),
    lead_time_minutes: z.number().int().min(0).nullable().optional(),
    max_advance_days: z.number().int().min(1).nullable().optional(),
    cancel_deadline_minutes: z.number().int().min(0).nullable().optional(),
    requires_confirmation: z.boolean().optional(),
});
export type BookingPolicyInput = z.infer<typeof bookingPolicySchema>;

const bookingPolicyOutputSchema = z.object({
    max_active_per_user: z.number().int().nullable().catch(null),
    lead_time_minutes: z.number().int().nullable().catch(null),
    max_advance_days: z.number().int().nullable().catch(null),
    cancel_deadline_minutes: z.number().int().nullable().catch(null),
    requires_confirmation: z.boolean().catch(false),
});

export const formFieldSchema = z
    .object({
        key: fieldKeySchema,
        label: labelSchema,
        type: z.enum(FORM_FIELD_TYPES),
        required: z.boolean().optional(),
        options: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
        placeholder: z.string().trim().max(200).optional(),
        max_length: z.number().int().min(1).max(5000).nullable().optional(),
    })
    .refine((field) => field.type !== 'select' || (field.options?.length ?? 0) > 0, {
        message: 'A select field needs options',
        path: ['options'],
    });
export type FormFieldInput = z.infer<typeof formFieldSchema>;

const formFieldOutputSchema = z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().catch(false),
    options: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
    max_length: z.number().int().nullable().catch(null),
});

export const requiredDocumentSchema = z.object({
    key: fieldKeySchema,
    label: labelSchema,
    required: z.boolean().optional(),
});

const requiredDocumentOutputSchema = z.object({
    key: z.string(),
    label: z.string(),
    required: z.boolean().catch(true),
});

const uniqueKeys = <T extends { key: string }>(items: T[]): boolean =>
    new Set(items.map((item) => item.key)).size === items.length;

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

export const includedOrganizationSchema = z.object({
    id: idOutputSchema,
    main_label: z.string(),
    main_category: z.string().optional(),
    main_image: z.string(),
    status: z.string().catch('active'),
    address: z.string().optional(),
    timezone: z.string().catch('UTC'),
});

export const includedCategorySchema = z.object({
    id: idOutputSchema,
    label: z.string(),
    enabled: enabledSchema.catch(false),
});

const serviceResponseSchemaFor = (bookings: z.ZodType) =>
    z.object({
        id: idOutputSchema,
        organization_id: idOutputSchema,
        category_id: idOutputSchema.nullable(),
        position: positionSchema.catch(0),
        label: z.string(),
        slug: z.string().optional(),
        enabled: enabledSchema,
        status: z.enum(SERVICE_STATUSES).catch('draft'),
        published_at: isoDateTimeSchema.nullable().catch(null),
        description: outputText.optional(),
        tags: z.array(z.string()).catch([]),
        duration_minutes: z.number().int().nullable().catch(null),
        buffer_minutes: z.number().int().nullable().catch(null),
        price: z.number().nullable().catch(null),
        currency: z.string().optional(),
        address: outputText.optional(),
        location: geoPointOutputSchema.optional(),
        working_hours: z
            .array(z.object({ day: z.enum(WEEKDAYS), from: outputText, to: outputText }))
            .catch([]),
        holidays: z.array(z.string()).catch([]),
        blackout_dates: z.array(z.string()).catch([]),
        booking_policy: bookingPolicyOutputSchema.catch({
            max_active_per_user: null,
            lead_time_minutes: null,
            max_advance_days: null,
            cancel_deadline_minutes: null,
            requires_confirmation: false,
        }),
        form_fields: z.array(formFieldOutputSchema).catch([]),
        required_documents: z.array(requiredDocumentOutputSchema).catch([]),
        value: serviceContentResponseSchema,
        options: z.array(serviceOptionResponseSchemaFor(bookings)),
        deleted_at: isoDateTimeSchema.nullable().catch(null),
        distance_m: z.number().optional(),
        organization: includedOrganizationSchema.optional(),
        category: includedCategorySchema.nullable().optional(),
        ...timestampsOutputSchema,
    });

export const serviceResponseSchema = serviceResponseSchemaFor(bookingsOutput);
export class ServiceResponseDto extends createZodDto(serviceResponseSchema) {}

export const maskedServiceResponseSchema = serviceResponseSchemaFor(maskedBookingsOutput);
export class MaskedServiceResponseDto extends createZodDto(maskedServiceResponseSchema) {}

export const serviceCardContentSchema = z.object({
    heading_value: outputText.optional(),
    image_value: outputText.optional(),
    price_value: outputText.optional(),
});

export const serviceCardSchema = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema,
    category_id: idOutputSchema.nullable(),
    position: positionSchema.catch(0),
    label: z.string(),
    slug: z.string().optional(),
    enabled: enabledSchema,
    status: z.enum(SERVICE_STATUSES).catch('draft'),
    published_at: isoDateTimeSchema.nullable().catch(null),
    description: outputText.optional(),
    tags: z.array(z.string()).catch([]),
    duration_minutes: z.number().int().nullable().catch(null),
    price: z.number().nullable().catch(null),
    currency: z.string().optional(),
    address: outputText.optional(),
    location: geoPointOutputSchema.optional(),
    value: serviceCardContentSchema,
    options_count: z.number().int().min(0).catch(0),
    ...timestampsOutputSchema,
});
export type ServiceCard = z.infer<typeof serviceCardSchema>;
export class ServiceCardDto extends createZodDto(serviceCardSchema) {}

export const SERVICE_CARD_FIELDS = [
    'organization_id',
    'category_id',
    'position',
    'label',
    'slug',
    'enabled',
    'status',
    'published_at',
    'description',
    'tags',
    'duration_minutes',
    'price',
    'currency',
    'address',
    'location',
    'value.heading_value',
    'value.image_value',
    'value.price_value',
    'created_at',
    'updated_at',
] as const;

export function viewerSeesBookings(request: Request): boolean {
    const { user } = request as Request & RequestWithUser;

    return user !== undefined && user.role !== ROLES.COMMON_USER;
}

export const serviceSchemaForViewer = (request: Request): ZodType =>
    viewerSeesBookings(request) ? serviceResponseSchema : maskedServiceResponseSchema;

const descriptiveFields = {
    slug: slugSchema,
    status: z.enum(SERVICE_STATUSES),
    description: text,
    tags: z.array(tagSchema).max(30),
    duration_minutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .nullable(),
    buffer_minutes: z
        .number()
        .int()
        .min(0)
        .max(24 * 60)
        .nullable(),
    price: z.number().min(0).max(1_000_000_000).nullable(),
    currency: currencySchema,
    address: z.string().trim().max(500),
    location: geoPointInputSchema.nullable(),
    working_hours: z.array(workingHoursSchema).max(28),
    holidays: z.array(monthDaySchema).max(100),
    blackout_dates: z.array(dateOnlySchema).max(400),
    booking_policy: bookingPolicySchema,
    form_fields: z.array(formFieldSchema).max(30).refine(uniqueKeys, { message: 'Keys must be unique' }),
    required_documents: z
        .array(requiredDocumentSchema)
        .max(30)
        .refine(uniqueKeys, { message: 'Keys must be unique' }),
};

export const createServiceSchema = z.object({
    organization_id: objectIdSchema,
    category_id: objectIdSchema.nullable().optional(),
    label: labelSchema.optional(),
    enabled: enabledSchema.optional(),
    value: serviceContentInputSchema.optional(),
    options: z.array(serviceOptionInputSchema).max(50).optional(),
    ...Object.fromEntries(Object.entries(descriptiveFields).map(([key, schema]) => [key, schema.optional()])),
}) as z.ZodObject<
    {
        organization_id: typeof objectIdSchema;
        category_id: z.ZodOptional<z.ZodNullable<typeof objectIdSchema>>;
        label: z.ZodOptional<typeof labelSchema>;
        enabled: z.ZodOptional<typeof enabledSchema>;
        value: z.ZodOptional<typeof serviceContentInputSchema>;
        options: z.ZodOptional<z.ZodArray<typeof serviceOptionInputSchema>>;
    } & { [K in keyof typeof descriptiveFields]: z.ZodOptional<(typeof descriptiveFields)[K]> }
>;
export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export class CreateServiceDto extends createZodDto(createServiceSchema) {}

export const updateServiceSchema = z
    .object({
        category_id: objectIdSchema.nullable(),
        label: labelSchema,
        enabled: enabledSchema,
        value: serviceContentInputSchema,
        ...descriptiveFields,
        options: z
            .never({ error: 'Options and slots are edited through /services/{id}/options' })
            .describe('Not accepted. Options and slots are edited through /services/{id}/options.'),
    })
    .partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export class UpdateServiceDto extends createZodDto(updateServiceSchema) {}

export const SERVICE_INCLUDES = ['organization', 'category'] as const;
export type ServiceInclude = (typeof SERVICE_INCLUDES)[number];

const includeSchema = z
    .string()
    .optional()
    .transform((value) =>
        value
            ? value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean)
            : [],
    )
    .pipe(z.array(z.enum(SERVICE_INCLUDES)).max(SERVICE_INCLUDES.length));

const csvTags = z
    .string()
    .optional()
    .transform((value) =>
        value
            ? value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean)
            : [],
    )
    .pipe(z.array(tagSchema).max(10));

export const listServicesQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    category_id: objectIdSchema.optional(),
    enabled: z.stringbool().optional(),
    status: z.enum(SERVICE_STATUSES).optional(),
    tags: csvTags,
    q: z.string().trim().min(1).max(200).optional(),
    deleted: z.stringbool().optional(),
    include: includeSchema,
    fields: z.string().optional(),
    facets: z.stringbool().optional(),
});
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
export class ListServicesQueryDto extends createZodDto(listServicesQuerySchema) {}

export const getServiceQuerySchema = z.object({ include: includeSchema, fields: z.string().optional() });
export type GetServiceQuery = z.infer<typeof getServiceQuerySchema>;
export class GetServiceQueryDto extends createZodDto(getServiceQuerySchema) {}

export const nearbyQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radius_m: z.coerce.number().int().min(1).max(200_000).default(5000),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    tags: csvTags,
    include: includeSchema,
    fields: z.string().optional(),
});
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;
export class NearbyQueryDto extends createZodDto(nearbyQuerySchema) {}

export const setServiceStatusSchema = z.object({ status: z.enum(SERVICE_STATUSES) });
export class SetServiceStatusDto extends createZodDto(setServiceStatusSchema) {}

export const deleteServiceQuerySchema = z.object({ permanent: z.stringbool().optional() });
export class DeleteServiceQueryDto extends createZodDto(deleteServiceQuerySchema) {}

export const serviceRevisionResponseSchema = z.object({
    id: idOutputSchema,
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    action: z.enum(REVISION_ACTIONS),
    actor_id: idOutputSchema.nullable(),
    actor_role: z.string().nullable(),
    changes: z.record(
        z.string(),
        z.object({ before: z.unknown().optional(), after: z.unknown().optional() }),
    ),
    ...timestampsOutputSchema,
});
export class ServiceRevisionResponseDto extends createZodDto(serviceRevisionResponseSchema) {}

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

export const createSlotSchema = slotInputSchema;

export const updateSlotSchema = z
    .object({
        label: labelSchema,
        date: dateOnlySchema,
        limit: limitSchema,
        time: z.array(timeEntryInput).max(200),
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

export const recurrenceSchema = z.object({
    recurrent_dates: z.array(recurrentDateSchema).max(7).nullable(),
});
export type RecurrenceInput = z.infer<typeof recurrenceSchema>;
export class RecurrenceDto extends createZodDto(recurrenceSchema) {}

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
    time: z.array(availabilityTimeSchema).optional(),
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

export const bookingFieldsSchema = z.record(fieldKeySchema, z.unknown());

export const createBookingSchema = z.object({
    option_id: uuidSchema,
    slot_id: uuidSchema,
    time: timeOfDaySchema.optional(),
    info: z.string().trim().max(1000).optional(),
    fields: bookingFieldsSchema.optional(),
    documents: z.array(fieldKeySchema).max(30).optional(),
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
    status: z.string(),
    date: outputText.nullish(),
    time: outputText.nullish(),
    created_at: isoDateTimeSchema,
});
export type BookingCreated = z.infer<typeof bookingCreatedResponseSchema>;
export class BookingCreatedResponseDto extends createZodDto(bookingCreatedResponseSchema) {}
