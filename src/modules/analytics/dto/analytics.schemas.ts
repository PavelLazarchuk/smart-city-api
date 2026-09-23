import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { EVENT_TYPE_VALUES } from '../../../common/decorators/track-event.decorator';
import { ROLE_VALUES } from '../../../common/decorators/roles.decorator';
import { cursorQuerySchema, paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idOutputSchema,
    isoDateTimeSchema,
    objectIdSchema,
    timestampsOutputSchema,
} from '../../../common/zod/primitives';

/** Rows carrying `user_phone` / `user_name` are super-admin-only, which the route enforces. */
export const analyticsEventResponseSchema = z.object({
    id: idOutputSchema,
    type: z.enum(EVENT_TYPE_VALUES),
    user_id: idOutputSchema.optional(),
    user_role: z.string().optional(),
    user_name: z.string().optional(),
    user_phone: z.string().optional(),
    organization_id: idOutputSchema.optional(),
    organization_label: z.string().optional(),
    service_id: idOutputSchema.optional(),
    service_label: z.string().optional(),
    service_type: z.string().optional(),
    child_type: z.string().optional(),
    date: z.string().optional(),
    time: z.string().optional(),
    request_id: z.string().optional(),
    source: z.string().optional(),
    ...timestampsOutputSchema,
});
export class AnalyticsEventResponseDto extends createZodDto(analyticsEventResponseSchema) {}

export const listAnalyticsQuerySchema = paginationQuerySchema.extend(cursorQuerySchema.shape).extend({
    type: z.enum(EVENT_TYPE_VALUES).optional(),
    organization_id: objectIdSchema.optional(),
    user_id: objectIdSchema.optional(),
    user_role: z.enum(ROLE_VALUES).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
});
export type ListAnalyticsQuery = z.infer<typeof listAnalyticsQuerySchema>;
export class ListAnalyticsQueryDto extends createZodDto(listAnalyticsQuerySchema) {}
