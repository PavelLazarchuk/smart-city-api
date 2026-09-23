import { type Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z, type ZodType } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idListSchema,
    idOutputSchema,
    isoDateTimeSchema,
    labelSchema,
    timestampsOutputSchema,
    timeZoneSchema,
    urlSchema,
} from '../../../common/zod/primitives';
import { categoryResponseSchema } from '../../categories/dto/category.schemas';
import { imageResponseSchema } from '../../images/dto/image.schemas';
import { infoSectionResponseSchema } from '../../infosections/dto/infosection.schemas';
import { newsResponseSchema } from '../../news/dto/news.schemas';
import {
    geoPointInputSchema,
    geoPointOutputSchema,
    maskedServiceResponseSchema,
    serviceCardSchema,
    serviceResponseSchema,
    viewerSeesBookings,
    workingHoursSchema,
} from '../../services/dto/service.schemas';
import { WEEKDAYS } from '../../services/schemas/service.schema';
import { ORGANIZATION_STATUSES } from '../schemas/organization.schema';

const monthDaySchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Must be MM-DD');

export const ORGANIZATION_INCLUDES = ['news', 'infosections', 'categories', 'services', 'images'] as const;
export type OrganizationInclude = (typeof ORGANIZATION_INCLUDES)[number];

export const organizationBaseResponseSchema = z.object({
    id: idOutputSchema,
    main_label: z.string(),
    category: z.string().optional(),
    main_category: z.string().optional(),
    main_image: z.string(),
    status: z.enum(ORGANIZATION_STATUSES).catch('active'),
    closed_reason: z.string().optional(),
    closed_until: isoDateTimeSchema.nullable().catch(null),
    address: z.string().optional(),
    location: geoPointOutputSchema.optional(),
    working_hours: z.array(z.object({ day: z.enum(WEEKDAYS), from: z.string(), to: z.string() })).catch([]),
    holidays: z.array(z.string()).catch([]),
    timezone: z.string().catch('UTC'),
    distance_m: z.number().optional(),
    ...timestampsOutputSchema,
});

export const organizationCountsSchema = z.object({
    news: z.number().int(),
    infosections: z.number().int(),
    categories: z.number().int(),
    services: z.number().int(),
    images: z.number().int(),
});

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

/** Child lists are capped at `PAGINATION.includeMaxItems` and services appear as cards. */
export const organizationDetailSchema = organizationBaseResponseSchema.extend({
    news: z.array(newsResponseSchema),
    infosections: z.array(infoSectionResponseSchema),
    categories: z.array(categoryResponseSchema.extend({ services: z.array(serviceCardSchema) })),
    services: z.array(serviceCardSchema),
    images: z.array(imageResponseSchema),
});
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;
export class OrganizationDetailDto extends createZodDto(organizationDetailSchema) {}

export const organizationResponseSchema = organizationBaseResponseSchema;
export class OrganizationResponseDto extends createZodDto(organizationResponseSchema) {}

const organizationExtras = {
    status: z.enum(ORGANIZATION_STATUSES),
    closed_reason: z.string().trim().max(500).nullable(),
    closed_until: isoDateTimeSchema.nullable(),
    address: z.string().trim().max(500).nullable(),
    location: geoPointInputSchema.nullable(),
    working_hours: z.array(workingHoursSchema).max(28),
    holidays: z.array(monthDaySchema).max(100),
    timezone: timeZoneSchema,
};

export const createOrganizationSchema = z.object({
    main_label: labelSchema,
    category: z.string().trim().max(200).optional(),
    main_category: z.string().trim().max(200).optional(),
    main_image: urlSchema,
    status: organizationExtras.status.optional(),
    closed_reason: z.string().trim().max(500).optional(),
    closed_until: isoDateTimeSchema.optional(),
    address: z.string().trim().max(500).optional(),
    location: geoPointInputSchema.optional(),
    working_hours: organizationExtras.working_hours.optional(),
    holidays: organizationExtras.holidays.optional(),
    timezone: timeZoneSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export class CreateOrganizationDto extends createZodDto(createOrganizationSchema) {}

export const updateOrganizationSchema = z
    .object({
        main_label: labelSchema,
        category: z.string().trim().max(200).nullable(),
        main_category: z.string().trim().max(200).nullable(),
        main_image: urlSchema,
        ...organizationExtras,
    })
    .partial();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export class UpdateOrganizationDto extends createZodDto(updateOrganizationSchema) {}

export const listOrganizationsQuerySchema = paginationQuerySchema.extend({
    main_category: z.string().trim().max(200).optional(),
    status: z.enum(ORGANIZATION_STATUSES).optional(),
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

export const nearbyOrganizationsQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radius_m: z.coerce.number().int().min(1).max(200_000).default(5000),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    main_category: z.string().trim().max(200).optional(),
});
export type NearbyOrganizationsQuery = z.infer<typeof nearbyOrganizationsQuerySchema>;
export class NearbyOrganizationsQueryDto extends createZodDto(nearbyOrganizationsQuerySchema) {}

export const reorderSchema = z.object({ ids: idListSchema });
export type ReorderInput = z.infer<typeof reorderSchema>;
export class ReorderDto extends createZodDto(reorderSchema) {}
