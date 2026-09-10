import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    enabledSchema,
    idOutputSchema,
    labelSchema,
    objectIdSchema,
    positionSchema,
    timestampsOutputSchema,
} from '../../../common/zod/primitives';

export const categoryResponseSchema = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema,
    position: positionSchema,
    label: z.string(),
    description: z.string().optional(),
    enabled: enabledSchema,
    ...timestampsOutputSchema,
});
export class CategoryResponseDto extends createZodDto(categoryResponseSchema) {}

export const createCategorySchema = z.object({
    organization_id: objectIdSchema,
    label: labelSchema,
    description: z.string().trim().max(2000).optional(),
    enabled: enabledSchema.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export class CreateCategoryDto extends createZodDto(createCategorySchema) {}

export const updateCategorySchema = z
    .object({
        label: labelSchema,
        description: z.string().trim().max(2000).nullable(),
        enabled: enabledSchema,
    })
    .partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}

export const listCategoriesQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    enabled: z.stringbool().optional(),
});
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export class ListCategoriesQueryDto extends createZodDto(listCategoriesQuerySchema) {}
