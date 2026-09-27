import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import { idOutputSchema, isoDateTimeSchema, objectIdSchema } from '../../../common/zod/primitives';
import { organizationResponseSchema } from '../../organizations/dto/organization.schemas';
import { serviceCardSchema } from '../../services/dto/service.schemas';
import { FAVORITE_TYPES } from '../schemas/favorite.schema';

export const favoriteParamsSchema = z.object({
    type: z.enum(FAVORITE_TYPES),
    id: objectIdSchema,
});
export type FavoriteParams = z.infer<typeof favoriteParamsSchema>;
export class FavoriteParamsDto extends createZodDto(favoriteParamsSchema) {}

export const listFavoritesQuerySchema = paginationQuerySchema.extend({
    type: z.enum(FAVORITE_TYPES).optional(),
});
export type ListFavoritesQuery = z.infer<typeof listFavoritesQuerySchema>;
export class ListFavoritesQueryDto extends createZodDto(listFavoritesQuerySchema) {}

export const favoriteResponseSchema = z.object({
    type: z.enum(FAVORITE_TYPES),
    id: idOutputSchema,
    organization_id: idOutputSchema,
    available: z.boolean(),
    service: serviceCardSchema.nullable().optional(),
    organization: organizationResponseSchema.nullable().optional(),
    created_at: isoDateTimeSchema,
});
export type FavoriteResource = z.infer<typeof favoriteResponseSchema>;
export class FavoriteResponseDto extends createZodDto(favoriteResponseSchema) {}
