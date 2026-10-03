import { ApiError } from '../http/api-error';

export function parseIdempotencyKey(raw: string | undefined): string | undefined {
    const key = raw?.trim();

    if (!key) return undefined;

    if (key.length > 128)
        throw ApiError.badRequest('VALIDATION_ERROR', [
            { path: 'Idempotency-Key', message: 'Must be at most 128 characters' },
        ]);

    return key;
}
