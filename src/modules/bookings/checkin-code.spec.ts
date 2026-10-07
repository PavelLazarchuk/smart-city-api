import { CHECKIN_CODE_PATTERN, generateCheckinCode, normalizeCheckinCode } from './checkin-code';

describe('check-in codes', () => {
    it('generates codes without look-alike characters', () => {
        const codes = Array.from({ length: 200 }, generateCheckinCode);

        for (const code of codes) {
            expect(code).toMatch(CHECKIN_CODE_PATTERN);
            expect(code).not.toMatch(/[01ILO]/);
        }

        expect(new Set(codes).size).toBeGreaterThan(190);
    });

    it('normalizes what staff type or scan', () => {
        expect(normalizeCheckinCode(' k7m-4px ')).toBe('K7M4PX');
        expect(normalizeCheckinCode('K7M 4PX')).toBe('K7M4PX');
    });
});
