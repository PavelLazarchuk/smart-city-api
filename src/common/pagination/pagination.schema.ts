import { z } from 'zod';

/** Query parameters accepted by every list endpoint. Defaults are applied from config. */
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

/**
 * High-volume collections offer both modes. `mode` says which one explicitly; without it, a `cursor`
 * still selects cursor mode and `page`/`sort` select offset mode, and the default is `cursor`.
 */
export const cursorQuerySchema = z.object({
    cursor: z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .optional(),
    mode: z.enum(['cursor', 'page']).optional(),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** The one place that decides between the two modes, so `sms` and `analytics` cannot drift apart. */
export function usesCursorMode(query: CursorQuery & { page?: number; sort?: string }): boolean {
    if (query.mode) return query.mode === 'cursor';

    return query.cursor !== undefined || (!query.page && !query.sort);
}
