import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../../../common/slug';
import {
    enabledSchema,
    idOutputSchema,
    isoDateTimeSchema,
    labelSchema,
    objectIdSchema,
    positionSchema,
    timestampsOutputSchema,
} from '../../../common/zod/primitives';

const text = z.string().trim().max(5000);
const slugSchema = z.string().trim().toLowerCase().min(1).max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN);
const rubricSchema = z.string().trim().min(1).max(100);

export const newsContentSchema = z.object({
    heading_label: text.optional(),
    heading_value: text.optional(),
    text_label: text.optional(),
    text_value: text.optional(),
    image_label: text.optional(),
    image_value: text.optional(),
    link_label: text.optional(),
    link_value: text.optional(),
});

export const newsResponseSchema = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema,
    position: positionSchema,
    label: z.string(),
    slug: z.string().optional(),
    rubric: z.string().optional(),
    enabled: enabledSchema,
    date: isoDateTimeSchema,
    publish_at: isoDateTimeSchema.nullable().catch(null),
    is_main: z.boolean(),
    is_offer: z.boolean(),
    expires_at: isoDateTimeSchema.optional(),
    value: newsContentSchema,
    ...timestampsOutputSchema,
});
export class NewsResponseDto extends createZodDto(newsResponseSchema) {}

export const createNewsSchema = z.object({
    organization_id: objectIdSchema,
    label: labelSchema,
    slug: slugSchema.optional(),
    rubric: rubricSchema.nullable().optional(),
    enabled: enabledSchema.optional(),
    date: isoDateTimeSchema.optional(),
    publish_at: isoDateTimeSchema.nullable().optional(),
    is_main: z.boolean().optional(),
    is_offer: z.boolean().optional(),
    expires_at: isoDateTimeSchema.nullable().optional(),
    value: newsContentSchema.optional(),
});
export type CreateNewsInput = z.infer<typeof createNewsSchema>;
export class CreateNewsDto extends createZodDto(createNewsSchema) {}

export const updateNewsSchema = createNewsSchema.omit({ organization_id: true }).partial();
export type UpdateNewsInput = z.infer<typeof updateNewsSchema>;
export class UpdateNewsDto extends createZodDto(updateNewsSchema) {}

export const listNewsQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    enabled: z.stringbool().optional(),
    main: z.stringbool().optional(),
    offers: z.stringbool().optional(),
    rubric: rubricSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
});
export type ListNewsQuery = z.infer<typeof listNewsQuerySchema>;
export class ListNewsQueryDto extends createZodDto(listNewsQuerySchema) {}

export const rssQuerySchema = z.object({
    organization_id: objectIdSchema.optional(),
    rubric: rubricSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RssQuery = z.infer<typeof rssQuerySchema>;
export class RssQueryDto extends createZodDto(rssQuerySchema) {}
