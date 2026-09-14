import { type Request } from 'express';

export function routeOf(request: Request): string {
    const route = (request as { route?: { path?: unknown } }).route;
    const path = route?.path;

    if (typeof path !== 'string') return 'unmatched';

    const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';

    return `${base}${path === '/' ? '' : path}` || '/';
}
