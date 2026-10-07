import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const CHECKIN_CODE_LENGTH = 6;
export const CHECKIN_CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CHECKIN_CODE_LENGTH}}$`);

export function generateCheckinCode(): string {
    let code = '';

    for (let i = 0; i < CHECKIN_CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];

    return code;
}

export function normalizeCheckinCode(raw: string): string {
    return raw.replace(/[\s-]/g, '').toUpperCase();
}
