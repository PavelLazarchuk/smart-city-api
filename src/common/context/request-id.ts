import { type IncomingMessage } from 'node:http';
import { ulid } from 'ulid';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function resolveRequestId(req: IncomingMessage & { id?: unknown }): string {
    if (typeof req.id === 'string' && req.id.length > 0) return req.id;

    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    const id = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : ulid();
    req.id = id;

    return id;
}
