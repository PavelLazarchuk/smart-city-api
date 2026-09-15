import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { OUTBOX_EVENT_TYPES, OUTBOX_STATUSES } from '../../../common/outbox/schemas/outbox-event.schema';
import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idOutputSchema,
    isoDateTimeSchema,
    objectIdSchema,
    timestampsOutputSchema,
    urlSchema,
} from '../../../common/zod/primitives';

const eventsSchema = z.array(z.enum(OUTBOX_EVENT_TYPES)).min(1).max(OUTBOX_EVENT_TYPES.length);

export const webhookResponseSchema = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema.nullable(),
    url: z.string(),
    events: z.array(z.string()),
    enabled: z.boolean(),
    description: z.string().optional(),
    last_delivery_at: isoDateTimeSchema.optional(),
    last_failure_at: isoDateTimeSchema.optional(),
    last_error: z.string().optional(),
    consecutive_failures: z.number().int().catch(0),
    ...timestampsOutputSchema,
});
export class WebhookResponseDto extends createZodDto(webhookResponseSchema) {}

export const webhookCreatedResponseSchema = webhookResponseSchema.extend({ secret: z.string() });
export class WebhookCreatedResponseDto extends createZodDto(webhookCreatedResponseSchema) {}

export const createWebhookSchema = z.object({
    organization_id: objectIdSchema.nullable().optional(),
    url: urlSchema,
    events: eventsSchema,
    enabled: z.boolean().optional(),
    description: z.string().trim().max(500).optional(),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export class CreateWebhookDto extends createZodDto(createWebhookSchema) {}

export const updateWebhookSchema = z
    .object({
        url: urlSchema,
        events: eventsSchema,
        enabled: z.boolean(),
        description: z.string().trim().max(500).nullable(),
    })
    .partial();
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
export class UpdateWebhookDto extends createZodDto(updateWebhookSchema) {}

export const listWebhooksQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
});
export type ListWebhooksQuery = z.infer<typeof listWebhooksQuerySchema>;
export class ListWebhooksQueryDto extends createZodDto(listWebhooksQuerySchema) {}

export const outboxEventResponseSchema = z.object({
    id: z.string(),
    type: z.string(),
    organization_id: idOutputSchema.nullable(),
    status: z.enum(OUTBOX_STATUSES),
    attempts: z.number().int(),
    next_attempt_at: isoDateTimeSchema,
    delivered_at: isoDateTimeSchema.optional(),
    last_error: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
    deliveries: z.array(
        z.object({
            target: z.string(),
            status: z.enum(OUTBOX_STATUSES),
            attempts: z.number().int(),
            last_error: z.string().optional(),
            delivered_at: isoDateTimeSchema.optional(),
        }),
    ),
    ...timestampsOutputSchema,
});
export class OutboxEventResponseDto extends createZodDto(outboxEventResponseSchema) {}

export const listOutboxQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    type: z.enum(OUTBOX_EVENT_TYPES).optional(),
    status: z.enum(OUTBOX_STATUSES).optional(),
});
export type ListOutboxQuery = z.infer<typeof listOutboxQuerySchema>;
export class ListOutboxQueryDto extends createZodDto(listOutboxQuerySchema) {}

export const webhookTestResponseSchema = z.object({ event_id: z.string(), queued: z.literal(true) });
export class WebhookTestResponseDto extends createZodDto(webhookTestResponseSchema) {}
