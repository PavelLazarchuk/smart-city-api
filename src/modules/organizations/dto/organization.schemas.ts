import { type Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z, type ZodType } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idListSchema,
    idOutputSchema,
    labelSchema,
    timestampsOutputSchema,
    urlSchema,
} from '../../../common/zod/primitives';
import { categoryResponseSchema } from '../../categories/dto/category.schemas';
import { imageResponseSchema } from '../../images/dto/image.schemas';
import { infoSectionResponseSchema } from '../../infosections/dto/infosection.schemas';
import { newsResponseSchema } from '../../news/dto/news.schemas';
import {
    maskedServiceResponseSchema,
    serviceResponseSchema,
    viewerSeesBookings,
} from '../../services/dto/service.schemas';

export const ORGANIZATION_INCLUDES = ['news', 'infosections', 'categories', 'services', 'images'] as const;
export type OrganizationInclude = (typeof ORGANIZATION_INCLUDES)[number];

export const organizationBaseResponseSchema = z.object({
    id: idOutputSchema,
    main_label: z.string(),
    category: z.string().optional(),
    main_category: z.string().optional(),
    main_image: z.string(),
    ...timestampsOutputSchema,
});

export const organizationCountsSchema = z.object({
    news: z.number().int(),
    infosections: z.number().int(),
    categories: z.number().int(),
    services: z.number().int(),
    images: z.number().int(),
});

/** List row: the complete organization document plus computed counts and opt-in includes. */
export const organizationListItemSchema = organizationBaseResponseSchema.extend({
    counts: organizationCountsSchema,
    news: z.array(newsResponseSchema).optional(),
    infosections: z.array(infoSectionResponseSchema).optional(),
    categories: z.array(categoryResponseSchema).optional(),
    services: z.array(serviceResponseSchema).optional(),
    images: z.array(imageResponseSchema).optional(),
});
export class OrganizationListItemDto extends createZodDto(organizationListItemSchema) {}

export const maskedOrganizationListItemSchema = organizationListItemSchema.extend({
    services: z.array(maskedServiceResponseSchema).optional(),
});
export class MaskedOrganizationListItemDto extends createZodDto(maskedOrganizationListItemSchema) {}

export const organizationListSchemaForViewer = (request: Request): ZodType =>
    viewerSeesBookings(request) ? organizationListItemSchema : maskedOrganizationListItemSchema;

/**
 * Detail: the tree with two independent top-level arrays. Child lists are capped at
 * `INCLUDE_MAX_ITEMS` and services carry anonymised bookings only.
 */
export const organizationDetailSchema = organizationBaseResponseSchema.extend({
    news: z.array(newsResponseSchema),
    infosections: z.array(infoSectionResponseSchema),
    categories: z.array(categoryResponseSchema.extend({ services: z.array(maskedServiceResponseSchema) })),
    services: z.array(maskedServiceResponseSchema),
    images: z.array(imageResponseSchema),
});
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;
export class OrganizationDetailDto extends createZodDto(organizationDetailSchema) {}

export const organizationResponseSchema = organizationBaseResponseSchema;
export class OrganizationResponseDto extends createZodDto(organizationResponseSchema) {}

export const createOrganizationSchema = z.object({
    main_label: labelSchema,
    category: z.string().trim().max(200).optional(),
    main_category: z.string().trim().max(200).optional(),
    main_image: urlSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export class CreateOrganizationDto extends createZodDto(createOrganizationSchema) {}

export const updateOrganizationSchema = z
    .object({
        main_label: labelSchema,
        category: z.string().trim().max(200).nullable(),
        main_category: z.string().trim().max(200).nullable(),
        main_image: urlSchema,
    })
    .partial();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export class UpdateOrganizationDto extends createZodDto(updateOrganizationSchema) {}

export const listOrganizationsQuerySchema = paginationQuerySchema.extend({
    main_category: z.string().trim().max(200).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    empty: z.stringbool().optional(),
    include: z
        .string()
        .optional()
        .transform((value) =>
            value
                ? value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean)
                : [],
        )
        .pipe(z.array(z.enum(ORGANIZATION_INCLUDES)).max(ORGANIZATION_INCLUDES.length)),
});
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;
export class ListOrganizationsQueryDto extends createZodDto(listOrganizationsQuerySchema) {}

export const reorderSchema = z.object({ ids: idListSchema });
export type ReorderInput = z.infer<typeof reorderSchema>;
export class ReorderDto extends createZodDto(reorderSchema) {}
