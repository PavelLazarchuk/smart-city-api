import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { AppConfig } from '../config/app-config';
import { type AuthUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { ROLES } from '../decorators/roles.decorator';
import { ApiError } from '../http/api-error';
import { MetricsService } from './metrics.service';

/**
 * `@Public()` because Prometheus carries no session; the bearer is `METRICS_TOKEN` or a super-admin token.
 * Without `METRICS_TOKEN` it stays super-admin-only: a forgotten variable must not publish every counter.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
    constructor(
        private readonly metrics: MetricsService,
        private readonly config: AppConfig,
    ) {}

    @Get()
    @Public()
    @Header('Cache-Control', 'no-store')
    async scrape(
        @Req() request: Request & { user?: AuthUser },
        @Res({ passthrough: true }) response: Response,
    ): Promise<string> {
        if (!this.config.metrics.enabled) throw ApiError.notFound('NOT_FOUND');

        this.assertAuthorized(request);
        response.setHeader('Content-Type', this.metrics.contentType);

        return this.metrics.render();
    }

    private assertAuthorized(request: Request & { user?: AuthUser }): void {
        if (request.user?.role === ROLES.SUPER_ADMIN) return;

        const expected = this.config.metrics.token;
        const header = request.headers.authorization ?? '';
        const provided = header.startsWith('Bearer ') ? header.slice(7) : header;

        if (!expected || !equals(provided, expected)) throw ApiError.unauthorized('UNAUTHENTICATED');
    }
}

function equals(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    return a.length === b.length && timingSafeEqual(a, b);
}
