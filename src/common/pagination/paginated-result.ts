export interface PaginatedResult<T> {
    items: T[];
    total: number;
    page: number;
    limit: number;
    next_cursor?: string | null;
    meta_extra?: Record<string, unknown>;
}

export interface PaginationMeta {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    has_next: boolean;
    next_cursor?: string | null;
    [key: string]: unknown;
}

export function isPaginatedResult(value: unknown): value is PaginatedResult<unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as PaginatedResult<unknown>).items) &&
        typeof (value as PaginatedResult<unknown>).total === 'number'
    );
}

export function paginationMeta(result: PaginatedResult<unknown>): PaginationMeta {
    const totalPages = result.limit > 0 ? Math.ceil(result.total / result.limit) : 0;
    const meta: PaginationMeta = {
        page: result.page,
        limit: result.limit,
        total: result.total,
        total_pages: totalPages,
        has_next: result.next_cursor !== undefined ? result.next_cursor !== null : result.page < totalPages,
        ...(result.meta_extra ?? {}),
    };

    if (result.next_cursor !== undefined) meta.next_cursor = result.next_cursor;

    return meta;
}
