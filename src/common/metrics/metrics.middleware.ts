import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

import { MetricsService } from './metrics.service';
import { routeOf } from './route-of';

/** Middleware, not an interceptor: 401/403/429 never reach one, and those are the responses to count. */
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
