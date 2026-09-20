import { type ZodType } from 'zod';

import { ApiError } from './api-error';

/** A discriminated union cannot back a `createZodDto` class, and picking the schema by role needs the principal. */
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
