import { AppConfig } from '../config/app-config';
import { validateEnv } from '../config/env.schema';
import { paginationMeta } from './paginated-result';
import { PaginationService } from './pagination.service';

const config = new AppConfig(
    validateEnv({
        MONGO_URI: 'mongodb://localhost/x',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
    }),
);

describe('PaginationService', () => {
    const service = new PaginationService(config);

    it('applies config defaults and clamps the limit', () => {
        expect(service.resolve({}, { sortable: ['created_at'], defaultSort: 'created_at' })).toEqual({
            page: 1,
            limit: 30,
            skip: 0,
            sort: { created_at: -1, _id: -1 },
        });
        expect(
            service.resolve({ page: 3, limit: 500 }, { sortable: ['created_at'], defaultSort: 'created_at' }),
        ).toMatchObject({
            page: 3,
            limit: 100,
            skip: 200,
        });
    });

    it('ignores unknown sort fields and honours order', () => {
        const resolved = service.resolve(
            { sort: 'password_hash', order: 'asc' },
            { sortable: ['label'], defaultSort: 'label' },
        );
        expect(resolved.sort).toEqual({ label: 1, _id: 1 });
    });

    it('builds meta', () => {
        expect(paginationMeta({ items: [], total: 41, page: 2, limit: 30 })).toEqual({
            page: 2,
            limit: 30,
            total: 41,
            total_pages: 2,
            has_next: false,
        });
        expect(paginationMeta({ items: [], total: 0, page: 1, limit: 30, next_cursor: null })).toMatchObject({
            has_next: false,
            next_cursor: null,
        });
        expect(
            paginationMeta({
                items: [],
                total: 9,
                page: 1,
                limit: 2,
                next_cursor: 'abc',
                meta_extra: { summary: { total: 9 } },
            }),
        ).toMatchObject({
            has_next: true,
            next_cursor: 'abc',
            summary: { total: 9 },
        });
    });
});
