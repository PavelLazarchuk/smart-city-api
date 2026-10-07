import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    dateOnlySchema,
    fieldKeySchema,
    idOutputSchema,
    isoDateTimeSchema,
    nameSchema,
    objectIdSchema,
    phoneSchema,
    timeOfDaySchema,
    uuidSchema,
} from '../../../common/zod/primitives';
import { SLOT_TYPES } from '../../services/schemas/service.schema';
import { CHECKIN_CODE_PATTERN, normalizeCheckinCode } from '../checkin-code';
import { BOOKING_STATUSES } from '../schemas/booking.schema';
import { WAITLIST_STATUSES } from '../schemas/waitlist.schema';

export const bookingResourceSchema = z.object({
    id: z.string(),
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    option_id: z.string(),
    slot_id: z.string(),
    child_type: z.string(),
    service_label: z.string().catch(''),
    date: z.string().nullable().catch(null),
    time: z.string().nullable().catch(null),
    end_time: z.string().nullable().catch(null),
    starts_at: isoDateTimeSchema.nullable().catch(null),
    ends_at: isoDateTimeSchema.nullable().catch(null),
    cancel_deadline_at: isoDateTimeSchema.nullable().catch(null),
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    info: z.string().catch(''),
    address: z.string().nullable().catch(null),
    fields: z.record(z.string(), z.unknown()).catch({}),
    documents: z.array(z.string()).catch([]),
    status: z.enum(BOOKING_STATUSES).catch('confirmed'),
    confirmed_at: isoDateTimeSchema.nullable().catch(null),
    arrived_at: isoDateTimeSchema.nullable().catch(null),
    checkin_code: z.string().nullable().catch(null),
    finished_at: isoDateTimeSchema.nullable().catch(null),
    late_cancel: z.boolean().catch(false),
    created_by: idOutputSchema.nullable().catch(null),
    created_at: isoDateTimeSchema,
});
export type BookingResource = z.infer<typeof bookingResourceSchema>;
export class BookingResourceDto extends createZodDto(bookingResourceSchema) {}

const dateRange = {
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
};

export const bookingStatusFilterSchema = z.enum([...BOOKING_STATUSES, 'active', 'all']).optional();

const bookingFilters = {
    organization_id: objectIdSchema.optional(),
    service_id: objectIdSchema.optional(),
    user_id: objectIdSchema.optional(),
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema.optional(),
    child_type: z.enum(SLOT_TYPES).optional(),
    status: bookingStatusFilterSchema,
    ...dateRange,
};

export const listBookingsQuerySchema = paginationQuerySchema.extend(bookingFilters);
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export class ListBookingsQueryDto extends createZodDto(listBookingsQuerySchema) {}

export const exportBookingsQuerySchema = z.object(bookingFilters);
export type ExportBookingsQuery = z.infer<typeof exportBookingsQuerySchema>;
export class ExportBookingsQueryDto extends createZodDto(exportBookingsQuerySchema) {}

export const listOwnBookingsQuerySchema = paginationQuerySchema.extend({
    status: bookingStatusFilterSchema,
    ...dateRange,
});
export type ListOwnBookingsQuery = z.infer<typeof listOwnBookingsQuerySchema>;
export class ListOwnBookingsQueryDto extends createZodDto(listOwnBookingsQuerySchema) {}

export const listServiceBookingsQuerySchema = paginationQuerySchema.extend({
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema.optional(),
    status: bookingStatusFilterSchema,
    ...dateRange,
});
export type ListServiceBookingsQuery = z.infer<typeof listServiceBookingsQuerySchema>;
export class ListServiceBookingsQueryDto extends createZodDto(listServiceBookingsQuerySchema) {}

export const setBookingStatusSchema = z.object({
    status: z.enum(['confirmed', 'completed', 'no_show', 'cancelled']),
});
export type SetBookingStatusInput = z.infer<typeof setBookingStatusSchema>;
export class SetBookingStatusDto extends createZodDto(setBookingStatusSchema) {}

export const checkInByCodeSchema = z.object({
    code: z
        .string()
        .trim()
        .max(32)
        .transform(normalizeCheckinCode)
        .pipe(z.string().regex(CHECKIN_CODE_PATTERN, 'Must be a check-in code')),
});
export type CheckInByCodeInput = z.infer<typeof checkInByCodeSchema>;
export class CheckInByCodeDto extends createZodDto(checkInByCodeSchema) {}

export const rescheduleBookingSchema = z.object({
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema,
    time: timeOfDaySchema.optional(),
    end_time: timeOfDaySchema.optional(),
    address: z.string().trim().min(1).max(500).optional(),
});
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;
export class RescheduleBookingDto extends createZodDto(rescheduleBookingSchema) {}

export const bookingStatsQuerySchema = z.object({
    organization_id: objectIdSchema.optional(),
    service_id: objectIdSchema.optional(),
    ...dateRange,
});
export type BookingStatsQuery = z.infer<typeof bookingStatsQuerySchema>;
export class BookingStatsQueryDto extends createZodDto(bookingStatsQuerySchema) {}

export const bookingStatsResponseSchema = z.object({
    total: z.number().int(),
    by_status: z.object({
        pending: z.number().int(),
        confirmed: z.number().int(),
        arrived: z.number().int(),
        completed: z.number().int(),
        no_show: z.number().int(),
        cancelled: z.number().int(),
    }),
    no_show_rate: z.number().min(0).max(1).nullable(),
    cancellation_rate: z.number().min(0).max(1).nullable(),
});
export type BookingStats = z.infer<typeof bookingStatsResponseSchema>;
export class BookingStatsResponseDto extends createZodDto(bookingStatsResponseSchema) {}

export const calendarTokenResponseSchema = z.object({ token: z.string(), path: z.string() });
export class CalendarTokenResponseDto extends createZodDto(calendarTokenResponseSchema) {}

export const calendarFeedQuerySchema = z.object({ token: z.string().max(128).optional() });
export class CalendarFeedQueryDto extends createZodDto(calendarFeedQuerySchema) {}

export const joinWaitlistSchema = z.object({
    option_id: uuidSchema,
    slot_id: uuidSchema,
    time: timeOfDaySchema.optional(),
});
export type JoinWaitlistInput = z.infer<typeof joinWaitlistSchema>;
export class JoinWaitlistDto extends createZodDto(joinWaitlistSchema) {}

export const waitlistEntryResponseSchema = z.object({
    id: z.string(),
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    option_id: z.string(),
    slot_id: z.string(),
    service_label: z.string().catch(''),
    date: z.string().nullable().catch(null),
    time: z.string().nullable().catch(null),
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    status: z.enum(WAITLIST_STATUSES).catch('waiting'),
    notified_at: isoDateTimeSchema.nullable().catch(null),
    created_at: isoDateTimeSchema,
});
export type WaitlistEntryResource = z.infer<typeof waitlistEntryResponseSchema>;
export class WaitlistEntryResponseDto extends createZodDto(waitlistEntryResponseSchema) {}

export const listWaitlistQuerySchema = paginationQuerySchema.extend({
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema.optional(),
});
export type ListWaitlistQuery = z.infer<typeof listWaitlistQuerySchema>;
export class ListWaitlistQueryDto extends createZodDto(listWaitlistQuerySchema) {}

export const bookingFieldsSchema = z.record(fieldKeySchema, z.unknown());

export const createBookingSchema = z.object({
    option_id: uuidSchema,
    slot_id: uuidSchema,
    time: timeOfDaySchema.optional(),
    end_time: timeOfDaySchema.optional(),
    address: z.string().trim().min(1).max(500).optional(),
    info: z.string().trim().max(1000).optional(),
    fields: bookingFieldsSchema.optional(),
    documents: z.array(fieldKeySchema).max(30).optional(),
    on_behalf: z.object({ phone: phoneSchema, name: nameSchema }).optional(),
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
    date: z.string().nullish(),
    time: z.string().nullish(),
    end_time: z.string().nullish(),
    user_id: idOutputSchema.optional(),
    created_at: isoDateTimeSchema,
});
export type BookingCreated = z.infer<typeof bookingCreatedResponseSchema>;
export class BookingCreatedResponseDto extends createZodDto(bookingCreatedResponseSchema) {}
