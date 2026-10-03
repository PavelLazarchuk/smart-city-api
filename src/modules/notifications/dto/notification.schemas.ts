import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { NOTIFICATIONS } from '../../../common/config/constants';
import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idOutputSchema,
    isoDateTimeSchema,
    objectIdSchema,
    plainTextSchema,
} from '../../../common/zod/primitives';
import { NOTIFICATION_AUDIENCES, NOTIFICATION_STATUSES, NOTIFICATION_TYPES } from '../notification-rules';

const scopeSchema = z.object({
    organization_id: objectIdSchema.optional(),
    audience: z.enum(NOTIFICATION_AUDIENCES).optional(),
});
export type NotificationScope = z.infer<typeof scopeSchema>;

export const unreadCountQuerySchema = scopeSchema.extend({
    by_organization: z.stringbool().optional(),
});
export type UnreadCountQuery = z.infer<typeof unreadCountQuerySchema>;
export class UnreadCountQueryDto extends createZodDto(unreadCountQuerySchema) {}

export const listNotificationsQuerySchema = paginationQuerySchema.extend(scopeSchema.shape).extend({
    status: z.enum([...NOTIFICATION_STATUSES, 'all']).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export class ListNotificationsQueryDto extends createZodDto(listNotificationsQuerySchema) {}

export const readAllSchema = scopeSchema.extend({
    before: isoDateTimeSchema.optional(),
});
export type ReadAllInput = z.infer<typeof readAllSchema>;
export class ReadAllDto extends createZodDto(readAllSchema) {}

export const unreadCountResponseSchema = z.object({
    unread: z.number().int().min(0),
    by_organization: z
        .array(z.object({ organization_id: idOutputSchema, unread: z.number().int().min(0) }))
        .optional(),
});
export type UnreadCount = z.infer<typeof unreadCountResponseSchema>;
export class UnreadCountResponseDto extends createZodDto(unreadCountResponseSchema) {}

export const readAllResponseSchema = z.object({ updated: z.number().int().min(0) });
export type ReadAllResult = z.infer<typeof readAllResponseSchema>;
export class ReadAllResponseDto extends createZodDto(readAllResponseSchema) {}

export const notificationDataSchema = z.object({
    booking_id: z.string().optional(),
    service_id: z.string().optional(),
    option_id: z.string().optional(),
    slot_id: z.string().optional(),
    service_label: z.string().optional(),
    date: z.string().optional(),
    time: z.string().optional(),
    end_time: z.string().optional(),
    previous_date: z.string().optional(),
    previous_time: z.string().optional(),
    reason: z.string().optional(),
    until: z.string().optional(),
    missed: z.number().int().optional(),
    requires_action: z.boolean().optional(),
    client_name: z.string().optional(),
    client_phone: z.string().optional(),
});

export const notificationResourceSchema = z.object({
    id: z.string(),
    type: z.enum(NOTIFICATION_TYPES),
    audience: z.enum(NOTIFICATION_AUDIENCES),
    status: z.enum(NOTIFICATION_STATUSES),
    title: z.string(),
    body: z.string(),
    organization: z.object({ id: idOutputSchema, label: z.string() }),
    data: notificationDataSchema,
    created_at: isoDateTimeSchema,
    read_at: isoDateTimeSchema.nullable(),
});
export type NotificationResource = z.infer<typeof notificationResourceSchema>;
export class NotificationResourceDto extends createZodDto(notificationResourceSchema) {}

export const sendMessageSchema = z.object({
    user_id: objectIdSchema,
    title: plainTextSchema(NOTIFICATIONS.titleMax, false).optional(),
    body: plainTextSchema(NOTIFICATIONS.bodyMax),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export class SendMessageDto extends createZodDto(sendMessageSchema) {}

export const sentMessageSchema = z.object({
    message_id: z.string(),
    user_id: idOutputSchema,
    title: z.string(),
    body: z.string(),
    created_at: isoDateTimeSchema,
});
export type SentMessage = z.infer<typeof sentMessageSchema>;
export class SentMessageDto extends createZodDto(sentMessageSchema) {}

export const listClientsQuerySchema = paginationQuerySchema.extend({
    q: z.string().trim().min(1).max(100).optional(),
});
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
export class ListClientsQueryDto extends createZodDto(listClientsQuerySchema) {}

export const organizationClientSchema = z.object({
    user_id: idOutputSchema,
    name: z.string(),
    phone: z.string(),
    bookings: z.number().int().min(0),
    last_booking_at: isoDateTimeSchema,
});
export type OrganizationClient = z.infer<typeof organizationClientSchema>;
export class OrganizationClientDto extends createZodDto(organizationClientSchema) {}
