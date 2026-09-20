import { z } from 'zod';

export const paginationQuerySchema = z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
    sort: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .optional(),
    order: z.enum(['asc', 'desc']).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Without an explicit `mode`, `cursor` selects cursor mode and `page`/`sort` offset mode; the default is `cursor`. */
export const cursorQuerySchema = z.object({
    cursor: z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .optional(),
    mode: z.enum(['cursor', 'page']).optional(),
    /** Counting the whole match is the most expensive query of a cursor page, and a scrolling client never reads it. */
    with_total: z.stringbool().optional(),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export function usesCursorMode(query: CursorQuery & { page?: number; sort?: string }): boolean {
    if (query.mode) return query.mode === 'cursor';

    return query.cursor !== undefined || (!query.page && !query.sort);
}
