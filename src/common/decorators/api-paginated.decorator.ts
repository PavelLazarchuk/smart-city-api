import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiQuery, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/** Swagger helper: documents the `{ data: T[], meta }` list envelope plus pagination query params. */
export function ApiPaginated(model: Type<unknown>, cursor = false): MethodDecorator {
    const decorators: MethodDecorator[] = [
        ApiExtraModels(model),
        ApiQuery({ name: 'page', required: false, type: Number }),
        ApiQuery({ name: 'limit', required: false, type: Number }),
        ApiQuery({ name: 'sort', required: false, type: String }),
        ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] }),
        ApiOkResponse({
            schema: {
                type: 'object',
                properties: {
                    data: { type: 'array', items: { $ref: getSchemaPath(model) } },
                    meta: {
                        type: 'object',
                        properties: {
                            page: { type: 'integer' },
                            limit: { type: 'integer' },
                            total: { type: 'integer', nullable: cursor },
                            total_pages: { type: 'integer', nullable: cursor },
                            has_next: { type: 'boolean' },
                            ...(cursor ? { next_cursor: { type: 'string', nullable: true } } : {}),
                        },
                    },
                },
            },
        }),
    ];

    if (cursor) {
        decorators.push(
            ApiQuery({ name: 'cursor', required: false, type: String }),
            ApiQuery({ name: 'with_total', required: false, type: Boolean }),
        );
    }

    return applyDecorators(...decorators);
}

/** Swagger helper: documents the `{ data: T }` single-entity envelope. */
export function ApiData(model: Type<unknown>, status = 200): MethodDecorator {
    return applyDecorators(
        ApiExtraModels(model),
        ApiResponse({
            status,
            schema: { type: 'object', properties: { data: { $ref: getSchemaPath(model) } } },
        }),
    );
}
