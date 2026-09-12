import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

import { MetricsService } from './metrics.service';

/**
 * Middleware rather than an interceptor: a request rejected by a guard (401, 403, 429) never reaches
 * an interceptor, and those are exactly the responses the error rate must show.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
    constructor(private readonly metrics: MetricsService) {}

    use(request: Request, response: Response, next: NextFunction): void {
        const started = process.hrtime.bigint();
        response.once('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
            this.metrics.observeHttp(request.method, routeOf(request), response.statusCode, durationMs);
        });
        next();
    }
}

/** The route pattern, never the URL: `/services/:id` keeps the label set bounded. */
function routeOf(request: Request): string {
    const route = (request as { route?: { path?: unknown } }).route;
    const path = route?.path;

    if (typeof path !== 'string') return 'unmatched';

    const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';

    return `${base}${path === '/' ? '' : path}` || '/';
}
