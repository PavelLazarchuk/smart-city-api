import { type Response } from 'supertest';

export const SENSITIVE_KEYS = [
    'password',
    'password_hash',
    'verificationKey',
    'verification_key',
    'code_hash',
    'refresh_token_hash',
];

export function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
    else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            keys.add(key);
            collectKeys(item, keys);
        }
    }

    return keys;
}

export function expectNoSensitiveKeys(body: unknown): void {
    const keys = collectKeys(body);

    for (const key of SENSITIVE_KEYS) expect(keys.has(key)).toBe(false);
}

export function expectError(res: Response, status: number, code?: string): void {
    expect(res.status).toBe(status);
    expect(res.body.error).toBeDefined();

    if (code) expect(res.body.error.code).toBe(code);

    expect(typeof res.body.error.message).toBe('string');
    expect(typeof res.body.error.request_id).toBe('string');
}

export function bodyContains(body: unknown, needle: string): boolean {
    return JSON.stringify(body).includes(needle);
}

export async function waitFor<T>(probe: () => Promise<T>, timeoutMs = 5000, intervalMs = 50): Promise<T> {
    const started = Date.now();

    for (;;) {
        const value = await probe();

        if (value) return value;

        if (Date.now() - started > timeoutMs) throw new Error('waitFor: condition not met in time');

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}
