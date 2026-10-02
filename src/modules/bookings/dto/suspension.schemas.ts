import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idOutputSchema,
    isoDateTimeSchema,
    objectIdSchema,
    phoneSchema,
} from '../../../common/zod/primitives';
import { SUSPENSION_KINDS } from '../schemas/suspension.schema';

export const suspensionResourceSchema = z.object({
    id: z.string(),
    user_id: idOutputSchema,
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    service_label: z.string().catch(''),
    active: z.boolean(),
    kind: z.enum(SUSPENSION_KINDS).nullable().catch(null),
    reason: z.string().nullable().catch(null),
    until: isoDateTimeSchema.nullable().catch(null),
    booking_ids: z.array(z.string()).catch([]),
    suspended_at: isoDateTimeSchema.nullable().catch(null),
    suspended_by: idOutputSchema.nullable().catch(null),
    lifted_at: isoDateTimeSchema.nullable().catch(null),
    lifted_by: idOutputSchema.nullable().catch(null),
});
export type SuspensionResource = z.infer<typeof suspensionResourceSchema>;
export class SuspensionResourceDto extends createZodDto(suspensionResourceSchema) {}

export const listSuspensionsQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    service_id: objectIdSchema.optional(),
    user_id: objectIdSchema.optional(),
    status: z.enum(['active', 'all']).optional(),
});
export type ListSuspensionsQuery = z.infer<typeof listSuspensionsQuerySchema>;
export class ListSuspensionsQueryDto extends createZodDto(listSuspensionsQuerySchema) {}

export const createSuspensionSchema = z
    .object({
        service_id: objectIdSchema,
        user_id: objectIdSchema.optional(),
        phone: phoneSchema.optional(),
        days: z.number().int().min(1).max(3650).nullable().optional(),
        reason: z.string().trim().min(1).max(500),
        notify: z.boolean().optional(),
    })
    .superRefine((input, ctx) => {
        if ((input.user_id === undefined) === (input.phone === undefined))
            ctx.addIssue({
                code: 'custom',
                path: ['user_id'],
                message: 'Provide exactly one of user_id and phone',
            });
    });
export type CreateSuspensionInput = z.infer<typeof createSuspensionSchema>;
export class CreateSuspensionDto extends createZodDto(createSuspensionSchema) {}
