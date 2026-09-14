import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    dateOnlySchema,
    idOutputSchema,
    isoDateTimeSchema,
    objectIdSchema,
    uuidSchema,
} from '../../../common/zod/primitives';
import { SLOT_TYPES } from '../../services/schemas/service.schema';

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
    user_id: idOutputSchema,
    person: z.string().catch(''),
    phone: z.string().catch(''),
    info: z.string().catch(''),
    created_at: isoDateTimeSchema,
});
export type BookingResource = z.infer<typeof bookingResourceSchema>;
export class BookingResourceDto extends createZodDto(bookingResourceSchema) {}

const dateRange = {
    date_from: dateOnlySchema.optional(),
    date_to: dateOnlySchema.optional(),
};

export const listBookingsQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    service_id: objectIdSchema.optional(),
    user_id: objectIdSchema.optional(),
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema.optional(),
    child_type: z.enum(SLOT_TYPES).optional(),
    ...dateRange,
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export class ListBookingsQueryDto extends createZodDto(listBookingsQuerySchema) {}

export const listOwnBookingsQuerySchema = paginationQuerySchema.extend(dateRange);
export type ListOwnBookingsQuery = z.infer<typeof listOwnBookingsQuerySchema>;
export class ListOwnBookingsQueryDto extends createZodDto(listOwnBookingsQuerySchema) {}

export const listServiceBookingsQuerySchema = paginationQuerySchema.extend({
    option_id: uuidSchema.optional(),
    slot_id: uuidSchema.optional(),
    ...dateRange,
});
export type ListServiceBookingsQuery = z.infer<typeof listServiceBookingsQuerySchema>;
export class ListServiceBookingsQueryDto extends createZodDto(listServiceBookingsQuerySchema) {}
