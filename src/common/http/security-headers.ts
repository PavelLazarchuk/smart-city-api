import { type RequestHandler } from 'express';
import helmet from 'helmet';

const API_CSP: Record<string, string[]> = {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'img-src': ["'self'", 'data:'],
    'script-src': ["'none'"],
    'style-src': ["'none'"],
    'connect-src': ["'self'"],
    'font-src': ["'none'"],
    'object-src': ["'none'"],
};

const DOCS_CSP: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'img-src': ["'self'", 'data:'],
    'script-src': ["'self'", "'unsafe-inline'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'connect-src': ["'self'"],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
};

const base = (directives: Record<string, string[]>): RequestHandler =>
    helmet({
        contentSecurityPolicy: { useDefaults: false, directives },
        crossOriginResourcePolicy: { policy: 'same-origin' },
        referrerPolicy: { policy: 'no-referrer' },
    });

export function securityHeaders(docsPrefix = '/api/docs'): RequestHandler {
    const api = base(API_CSP);
    const docs = base(DOCS_CSP);

    return (request, response, next) =>
        (request.path.startsWith(docsPrefix) ? docs : api)(request, response, next);
}

export function uploadsHeaders(origins: string[], maxAgeSeconds: number): RequestHandler {
    const allowed = new Set(origins);

    return (request, response, next) => {
        const origin = request.headers.origin;
        const permitted = typeof origin === 'string' && allowed.has(origin);

        response.vary('Origin');
        response.setHeader('Cross-Origin-Resource-Policy', permitted ? 'cross-origin' : 'same-origin');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        response.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);

        if (permitted) {
            response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        }

        next();
    };
}
