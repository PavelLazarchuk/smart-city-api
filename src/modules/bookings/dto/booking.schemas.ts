import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    dateOnlySchema,
    idOutputSchema,
    isoDateTimeSchema,
    objectIdSchema,
    timeOfDaySchema,
    uuidSchema,
} from '../../../common/zod/primitives';
import { SLOT_TYPES } from '../../services/schemas/service.schema';
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
    starts_at: isoDateTimeSchema.nullable().catch(null),
    cancel_deadline_at: isoDateTimeSchema.nullable().catch(null),
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    info: z.string().catch(''),
    fields: z.record(z.string(), z.unknown()).catch({}),
    documents: z.array(z.string()).catch([]),
    status: z.enum(BOOKING_STATUSES).catch('confirmed'),
    confirmed_at: isoDateTimeSchema.nullable().catch(null),
    finished_at: isoDateTimeSchema.nullable().catch(null),
    created_at: isoDateTimeSchema,
});
export type BookingResource = z.infer<typeof bookingResourceSchema>;
export class BookingResourceDto extends createZodDto(bookingResourceSchema) {}

const dateRange = {
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
};

export const bookingStatusFilterSchema = z.enum([...BOOKING_STATUSES, 'active', 'all']).optional();

export const listBookingsQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    service_id: objectIdSchema.optional(),
    user_id: objectIdSchema.optional(),
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema.optional(),
    child_type: z.enum(SLOT_TYPES).optional(),
    status: bookingStatusFilterSchema,
    ...dateRange,
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export class ListBookingsQueryDto extends createZodDto(listBookingsQuerySchema) {}

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

export const rescheduleBookingSchema = z.object({
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema,
    time: timeOfDaySchema.optional(),
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
        completed: z.number().int(),
        no_show: z.number().int(),
        cancelled: z.number().int(),
    }),
    no_show_rate: z.number().min(0).max(1).nullable(),
    cancellation_rate: z.number().min(0).max(1).nullable(),
});
export type BookingStats = z.infer<typeof bookingStatsResponseSchema>;
export class BookingStatsResponseDto extends createZodDto(bookingStatsResponseSchema) {}

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
