import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CHANNEL_TEMPLATE_LIMITS } from '../../../common/config/constants';
import { idOutputSchema, isoDateTimeSchema } from '../../../common/zod/primitives';
import { CHANNELS, CHANNEL_TEMPLATE_KEYS } from '../channel-catalogue';

const subjectSchema = z
    .string()
    .trim()
    .min(1)
    .max(CHANNEL_TEMPLATE_LIMITS.subject)
    .refine((value) => !/\p{Cc}/u.test(value), 'Must be a single line without control characters');

const bodySchema = z
    .string()
    .transform((value) => value.replace(/\r\n?/g, '\n').trim())
    .pipe(
        z
            .string()
            .min(1)
            .max(CHANNEL_TEMPLATE_LIMITS.mailBody)
            .refine(
                (value) => !/[^\P{Cc}\n\t]/u.test(value),
                'Must not contain control characters other than line breaks and tabs',
            ),
    );

export const saveChannelTemplateSchema = z.object({
    subject: subjectSchema.nullable().optional(),
    body: bodySchema,
});
export type SaveChannelTemplateInput = z.infer<typeof saveChannelTemplateSchema>;
export class SaveChannelTemplateDto extends createZodDto(saveChannelTemplateSchema) {}

export const previewChannelTemplateSchema = z.object({
    subject: subjectSchema.nullable().optional(),
    body: bodySchema.optional(),
});
export type PreviewChannelTemplateInput = z.infer<typeof previewChannelTemplateSchema>;
export class PreviewChannelTemplateDto extends createZodDto(previewChannelTemplateSchema) {}

export const channelTemplateResourceSchema = z.object({
    key: z.enum(CHANNEL_TEMPLATE_KEYS),
    event: z.string(),
    channel: z.enum(CHANNELS),
    variables: z.array(z.string()),
    custom: z.boolean(),
    subject: z.string().nullable(),
    body: z.string(),
    default_subject: z.string().nullable(),
    default_body: z.string(),
    updated_at: isoDateTimeSchema.nullable(),
    updated_by: idOutputSchema.nullable(),
});
export type ChannelTemplateResource = z.infer<typeof channelTemplateResourceSchema>;
export class ChannelTemplateResourceDto extends createZodDto(channelTemplateResourceSchema) {}

export const renderedTemplateSchema = z.object({
    subject: z.string().nullable(),
    body: z.string(),
});
export type RenderedTemplate = z.infer<typeof renderedTemplateSchema>;
export class RenderedTemplateDto extends createZodDto(renderedTemplateSchema) {}
