const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;

export const CSV_BOM = '\uFEFF';

export type CsvValue = string | number | boolean | Date | object | null | undefined;

function textOf(value: CsvValue): string {
    if (value === null || value === undefined) return '';

    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') return JSON.stringify(value);

    return String(value);
}

export function csvCell(value: CsvValue): string {
    let text = textOf(value);

    if (text.length > 0 && FORMULA_TRIGGERS.has(text[0]!) && !PLAIN_NUMBER.test(text)) text = `'${text}`;

    return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: readonly CsvValue[]): string {
    return `${values.map(csvCell).join(',')}\r\n`;
}
