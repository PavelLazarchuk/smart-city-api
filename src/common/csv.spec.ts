import { csvCell, csvLine } from './csv';

describe('csv', () => {
    it('renders empty values, dates and objects', () => {
        expect(csvCell(null)).toBe('');
        expect(csvCell(undefined)).toBe('');
        expect(csvCell(new Date('2026-10-03T10:00:00.000Z'))).toBe('2026-10-03T10:00:00.000Z');
        expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
        expect(csvCell(42)).toBe('42');
    });

    it('quotes separators, quotes and line breaks', () => {
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('two\nlines')).toBe('"two\nlines"');
    });

    it('neutralizes spreadsheet formulas but keeps plain numbers', () => {
        expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
        expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
        expect(csvCell('-2+3')).toBe("'-2+3");
        expect(csvCell('\tcmd')).toBe("'\tcmd");
        expect(csvCell('+380501234567')).toBe('+380501234567');
        expect(csvCell('-12.5')).toBe('-12.5');
    });

    it('joins a line with CRLF', () => {
        expect(csvLine(['a', null, 'b,c'])).toBe('a,,"b,c"\r\n');
    });
});
