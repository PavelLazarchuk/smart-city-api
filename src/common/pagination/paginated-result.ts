export interface PaginatedResult<T> {
    items: T[];
    /** `null` when the caller did not ask for a count (cursor pages default to that). */
    total: number | null;
    page: number;
    limit: number;
    next_cursor?: string | null;
    meta_extra?: Record<string, unknown>;
}

export interface PaginationMeta {
    page: number;
    limit: number;
    total: number | null;
    total_pages: number | null;
    has_next: boolean;
    next_cursor?: string | null;
    [key: string]: unknown;
}

export function isPaginatedResult(value: unknown): value is PaginatedResult<unknown> {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as PaginatedResult<unknown>;

    return (
        Array.isArray(candidate.items) && (typeof candidate.total === 'number' || candidate.total === null)
    );
}

export function paginationMeta(result: PaginatedResult<unknown>): PaginationMeta {
    const totalPages =
        result.total === null ? null : result.limit > 0 ? Math.ceil(result.total / result.limit) : 0;
    const meta: PaginationMeta = {
        page: result.page,
        limit: result.limit,
        total: result.total,
        total_pages: totalPages,
        has_next:
            result.next_cursor !== undefined
                ? result.next_cursor !== null
                : totalPages !== null && result.page < totalPages,
        ...(result.meta_extra ?? {}),
    };

    if (result.next_cursor !== undefined) meta.next_cursor = result.next_cursor;

    return meta;
}
