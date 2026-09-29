import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    enabledSchema,
    idOutputSchema,
    labelSchema,
    linkUrlSchema,
    objectIdSchema,
    phoneSchema,
    positionSchema,
    richTextSchema,
    timestampsOutputSchema,
} from '../../../common/zod/primitives';

const text = z.string().trim().max(5000);
const coordinate = z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d+)?$/, 'Must be a decimal coordinate');

const bodySchema = (richText: z.ZodType<string>, url: z.ZodType<string>) =>
    z.discriminatedUnion('control', [
        z.object({
            control: z.literal('text'),
            value: z.object({
                heading_label: text.optional(),
                heading_value: text.optional(),
                text_label: text.optional(),
                text_value: richText.optional(),
            }),
        }),
        z.object({
            control: z.literal('address'),
            value: z.object({
                text: text.optional(),
                lat: coordinate.optional(),
                lng: coordinate.optional(),
            }),
        }),
        z.object({ control: z.literal('link'), value: z.object({ text: text.optional(), url }) }),
        z.object({
            control: z.literal('phone'),
            value: z.object({ phone: phoneSchema, text: text.optional() }),
        }),
        z.object({
            control: z.literal('email'),
            value: z.object({ email: z.email(), text: text.optional() }),
        }),
    ]);

export const infoSectionBodySchema = bodySchema(z.string(), z.string());
const infoSectionInputSchema = bodySchema(richTextSchema(5000), linkUrlSchema);

const infoSectionCommon = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema,
    position: positionSchema,
    label: z.string(),
    enabled: enabledSchema,
    ...timestampsOutputSchema,
});

export const infoSectionResponseSchema = z.intersection(infoSectionCommon, infoSectionBodySchema);

/** A class cannot extend a union-typed constructor, so union DTOs are built on a loosely typed view. */
const loose = (schema: z.ZodType): z.ZodType<Record<string, unknown>> =>
    schema as z.ZodType<Record<string, unknown>>;

export class InfoSectionResponseDto extends createZodDto(loose(infoSectionResponseSchema)) {}

export const createInfoSectionSchema = z.intersection(
    z.object({
        organization_id: objectIdSchema,
        label: labelSchema,
        enabled: enabledSchema.optional(),
    }),
    infoSectionInputSchema,
);
export type CreateInfoSectionInput = z.infer<typeof createInfoSectionSchema>;
export class CreateInfoSectionDto extends createZodDto(loose(createInfoSectionSchema)) {}

/** Update: `control` and `value` travel together so the pair always validates as a whole. */
export const updateInfoSectionSchema = z.intersection(
    z.object({ label: labelSchema.optional(), enabled: enabledSchema.optional() }),
    z.union([
        infoSectionInputSchema,
        z.object({ control: z.never().optional(), value: z.never().optional() }),
    ]),
);
export type UpdateInfoSectionInput = z.infer<typeof updateInfoSectionSchema>;
export class UpdateInfoSectionDto extends createZodDto(loose(updateInfoSectionSchema)) {}

export const listInfoSectionsQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    enabled: z.stringbool().optional(),
});
export type ListInfoSectionsQuery = z.infer<typeof listInfoSectionsQuerySchema>;
export class ListInfoSectionsQueryDto extends createZodDto(listInfoSectionsQuerySchema) {}
