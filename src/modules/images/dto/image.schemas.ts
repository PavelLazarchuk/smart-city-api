import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import { idOutputSchema, objectIdSchema, timestampsOutputSchema } from '../../../common/zod/primitives';

export const imageResponseSchema = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema,
    name: z.string(),
    src: z.string(),
    mime_type: z.string(),
    size: z.number().int(),
    ...timestampsOutputSchema,
});
export class ImageResponseDto extends createZodDto(imageResponseSchema) {}

export const listImagesQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
});
export type ListImagesQuery = z.infer<typeof listImagesQuerySchema>;
export class ListImagesQueryDto extends createZodDto(listImagesQuerySchema) {}
