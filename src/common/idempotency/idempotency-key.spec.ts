import { ApiError } from '../http/api-error';
import { parseIdempotencyKey } from './idempotency-key';

describe('parseIdempotencyKey', () => {
    it('returns nothing for a missing or blank header', () => {
        expect(parseIdempotencyKey(undefined)).toBeUndefined();
        expect(parseIdempotencyKey('')).toBeUndefined();
        expect(parseIdempotencyKey('   ')).toBeUndefined();
    });

    it('trims the key', () => {
        expect(parseIdempotencyKey('  abc-123 ')).toBe('abc-123');
    });

    it('accepts a key of 128 characters and rejects a longer one', () => {
        expect(parseIdempotencyKey('a'.repeat(128))).toBe('a'.repeat(128));
        expect(() => parseIdempotencyKey('a'.repeat(129))).toThrow(ApiError);
    });
});
