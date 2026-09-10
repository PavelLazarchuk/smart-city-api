import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
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
    enabled: enabledSchema,
    date: isoDateTimeSchema,
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
    enabled: enabledSchema.optional(),
    date: isoDateTimeSchema.optional(),
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
});
export type ListNewsQuery = z.infer<typeof listNewsQuerySchema>;
export class ListNewsQueryDto extends createZodDto(listNewsQuerySchema) {}
