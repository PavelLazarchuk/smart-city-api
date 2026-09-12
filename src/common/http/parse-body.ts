import { type ZodType } from 'zod';

import { ApiError } from './api-error';

/**
 * Manual body parsing for the handlers whose payload is not a plain object schema — a discriminated
 * union cannot back a `createZodDto` class, and picking the schema by role needs the principal.
 * The rejection is the same `VALIDATION_ERROR` envelope the global pipe produces.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);

    if (result.success) return result.data;

    throw ApiError.badRequest(
        'VALIDATION_ERROR',
        result.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
            code: issue.code,
        })),
    );
}
