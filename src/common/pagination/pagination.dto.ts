import { createZodDto } from 'nestjs-zod';

import { cursorQuerySchema, paginationQuerySchema } from './pagination.schema';

export class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}
export class CursorPaginationQueryDto extends createZodDto(
    paginationQuerySchema.extend(cursorQuerySchema.shape),
) {}
