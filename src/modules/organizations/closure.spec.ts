import { isClosedAt } from './closure';

describe('isClosedAt', () => {
    const until = new Date('2026-11-02T00:00:00Z');

    it('is open for an active organization', () => {
        expect(isClosedAt({ status: 'active', closed_until: until }, new Date('2026-11-01T10:00:00Z'))).toBe(
            false,
        );
    });

    it('is closed before the reopening and open from it on', () => {
        const closed = { status: 'temporarily_closed' as const, closed_until: until };

        expect(isClosedAt(closed, new Date('2026-11-01T23:59:00Z'))).toBe(true);
        expect(isClosedAt(closed, until)).toBe(false);
        expect(isClosedAt(closed, new Date('2026-11-09T09:00:00Z'))).toBe(false);
    });

    it('is closed at any moment without a reopening date', () => {
        expect(isClosedAt({ status: 'temporarily_closed', closed_until: null }, new Date('2030-01-01'))).toBe(
            true,
        );
    });
});
