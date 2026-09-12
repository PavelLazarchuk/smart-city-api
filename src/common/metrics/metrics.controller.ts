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
 * Scrape endpoint. It is `@Public()` because Prometheus carries no session: the bearer is
 * `METRICS_TOKEN`, and a super-admin access token is accepted as well for a quick manual look.
 *
 * With no `METRICS_TOKEN` configured the endpoint is closed to everything but a super-admin token
 * rather than open to everyone: the registry names every route, job and organization-level counter,
 * and an environment that simply forgot the variable — staging, QA — must not publish all of it.
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
