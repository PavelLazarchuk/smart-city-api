import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import { idOutputSchema, objectIdSchema, timestampsOutputSchema } from '../../../common/zod/primitives';
import { ARCHIVE_TYPES } from '../schemas/archive.schema';

export const archiveResponseSchema = z.object({
    id: idOutputSchema,
    organization_id: idOutputSchema,
    service_id: idOutputSchema.optional(),
    type: z.enum(ARCHIVE_TYPES),
    data: z.record(z.string(), z.unknown()),
    ...timestampsOutputSchema,
});
export class ArchiveResponseDto extends createZodDto(archiveResponseSchema) {}

/** Snapshots are opaque JSON, but not unbounded: `BODY_LIMIT` alone is a very generous ceiling. */
export const MAX_ARCHIVE_DATA_BYTES = 64 * 1024;

export const createArchiveSchema = z.object({
    organization_id: objectIdSchema,
    service_id: objectIdSchema.optional(),
    type: z.enum(ARCHIVE_TYPES),
    data: z
        .record(z.string(), z.unknown())
        .refine(
            (value) => Buffer.byteLength(JSON.stringify(value) ?? '') <= MAX_ARCHIVE_DATA_BYTES,
            `data must not exceed ${MAX_ARCHIVE_DATA_BYTES} bytes of JSON`,
        ),
});
export type CreateArchiveInput = z.infer<typeof createArchiveSchema>;
export class CreateArchiveDto extends createZodDto(createArchiveSchema) {}

export const listArchivesQuerySchema = paginationQuerySchema.extend({
    organization_id: objectIdSchema.optional(),
    type: z.enum(ARCHIVE_TYPES).optional(),
});
export type ListArchivesQuery = z.infer<typeof listArchivesQuerySchema>;
export class ListArchivesQueryDto extends createZodDto(listArchivesQuerySchema) {}
