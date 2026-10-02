import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { NOTIFICATION_TEMPLATE_LIMITS } from '../../../common/config/constants';
import { idOutputSchema, isoDateTimeSchema } from '../../../common/zod/primitives';
import { NOTIFICATION_CHANNELS, NOTIFICATION_KEYS } from '../notification-catalogue';

const subjectSchema = z
    .string()
    .trim()
    .min(1)
    .max(NOTIFICATION_TEMPLATE_LIMITS.subject)
    .refine((value) => !/\p{Cc}/u.test(value), 'Must be a single line without control characters');

const bodySchema = z
    .string()
    .transform((value) => value.replace(/\r\n?/g, '\n').trim())
    .pipe(
        z
            .string()
            .min(1)
            .max(NOTIFICATION_TEMPLATE_LIMITS.mailBody)
            .refine(
                (value) => !/[^\P{Cc}\n\t]/u.test(value),
                'Must not contain control characters other than line breaks and tabs',
            ),
    );

export const saveNotificationTemplateSchema = z.object({
    subject: subjectSchema.nullable().optional(),
    body: bodySchema,
});
export type SaveNotificationTemplateInput = z.infer<typeof saveNotificationTemplateSchema>;
export class SaveNotificationTemplateDto extends createZodDto(saveNotificationTemplateSchema) {}

export const previewNotificationTemplateSchema = z.object({
    subject: subjectSchema.nullable().optional(),
    body: bodySchema.optional(),
});
export type PreviewNotificationTemplateInput = z.infer<typeof previewNotificationTemplateSchema>;
export class PreviewNotificationTemplateDto extends createZodDto(previewNotificationTemplateSchema) {}

export const notificationTemplateResourceSchema = z.object({
    key: z.enum(NOTIFICATION_KEYS),
    event: z.string(),
    channel: z.enum(NOTIFICATION_CHANNELS),
    variables: z.array(z.string()),
    custom: z.boolean(),
    subject: z.string().nullable(),
    body: z.string(),
    default_subject: z.string().nullable(),
    default_body: z.string(),
    updated_at: isoDateTimeSchema.nullable(),
    updated_by: idOutputSchema.nullable(),
});
export type NotificationTemplateResource = z.infer<typeof notificationTemplateResourceSchema>;
export class NotificationTemplateResourceDto extends createZodDto(notificationTemplateResourceSchema) {}

export const renderedNotificationSchema = z.object({
    subject: z.string().nullable(),
    body: z.string(),
});
export type RenderedNotification = z.infer<typeof renderedNotificationSchema>;
export class RenderedNotificationDto extends createZodDto(renderedNotificationSchema) {}
