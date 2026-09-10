import { Injectable } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import { ApiError } from '../http/api-error';
import { type PaginationQuery } from './pagination.schema';

export interface ResolvedPagination {
    page: number;
    limit: number;
    skip: number;
    sort: Record<string, 1 | -1>;
}

export interface PaginationDefaults {
    sortable: readonly string[];
    defaultSort: string;
    defaultOrder?: 'asc' | 'desc';
}

@Injectable()
export class PaginationService {
    constructor(private readonly config: AppConfig) {}

    /**
     * Offset pagination has a configured depth ceiling: without it `?page=100000000` turns any public
     * list into an unbounded `$skip`.
     */
    resolve(query: PaginationQuery, defaults: PaginationDefaults): ResolvedPagination {
        const page = query.page ?? 1;

        if (page > this.config.pagination.maxPage) throw ApiError.unprocessable('PAGE_OUT_OF_RANGE');

        const limit = Math.min(
            query.limit ?? this.config.pagination.defaultLimit,
            this.config.pagination.maxLimit,
        );
        const sortField =
            query.sort && defaults.sortable.includes(query.sort) ? query.sort : defaults.defaultSort;
        const order = query.order ?? defaults.defaultOrder ?? 'desc';
        const sort: Record<string, 1 | -1> = { [sortField]: order === 'asc' ? 1 : -1 };

        if (sortField !== '_id') sort['_id'] = sort[sortField] ?? -1;

        return { page, limit, skip: (page - 1) * limit, sort };
    }

    get maxLimit(): number {
        return this.config.pagination.maxLimit;
    }

    get maxPage(): number {
        return this.config.pagination.maxPage;
    }
}
