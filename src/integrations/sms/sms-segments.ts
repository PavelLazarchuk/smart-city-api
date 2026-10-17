import { SMS_SEGMENTS } from '../../common/config/constants';

export type SmsEncoding = 'gsm' | 'ucs2';

export interface SmsSegments {
    encoding: SmsEncoding;
    parts: string[];
}

const GSM_BASIC = new Set(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('\f^{}\\[~]|€');

const LIMITS: Record<SmsEncoding, { single: number; part: number }> = {
    gsm: { single: 160, part: 153 },
    ucs2: { single: 70, part: 67 },
};

export function smsEncoding(text: string): SmsEncoding {
    for (const char of text) if (!GSM_BASIC.has(char) && !GSM_EXTENDED.has(char)) return 'ucs2';

    return 'gsm';
}

function units(char: string, encoding: SmsEncoding): number {
    if (encoding === 'ucs2') return char.length;

    return GSM_EXTENDED.has(char) ? 2 : 1;
}

function measure(text: string, encoding: SmsEncoding): number {
    let total = 0;

    for (const char of text) total += units(char, encoding);

    return total;
}

function chunk(text: string, encoding: SmsEncoding, size: number): string[] {
    const parts: string[] = [];
    let current = '';
    let used = 0;

    for (const char of text) {
        const cost = units(char, encoding);

        if (used + cost > size) {
            parts.push(current);
            current = '';
            used = 0;
        }

        current += char;
        used += cost;
    }

    if (current) parts.push(current);

    return parts;
}

export function fitSms(text: string, maxParts: number = SMS_SEGMENTS.maxParts): string {
    const encoding = smsEncoding(text);
    const { single, part } = LIMITS[encoding];
    const capacity = maxParts <= 1 ? single : part * maxParts;

    if (measure(text, encoding) <= capacity) return text;

    const ellipsis = encoding === 'gsm' ? '...' : '…';
    const room = capacity - measure(ellipsis, encoding);
    let result = '';
    let used = 0;

    for (const char of text) {
        const cost = units(char, encoding);

        if (used + cost > room) break;

        result += char;
        used += cost;
    }

    return `${result.trimEnd()}${ellipsis}`;
}

export function splitSms(text: string): SmsSegments {
    const encoding = smsEncoding(text);
    const { single, part } = LIMITS[encoding];

    if (measure(text, encoding) <= single) return { encoding, parts: [text] };

    return { encoding, parts: chunk(text, encoding, part) };
}
