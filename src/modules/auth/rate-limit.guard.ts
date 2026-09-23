import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
    getOptionsToken,
    getStorageToken,
    type ThrottlerModuleOptions,
    type ThrottlerRequest,
    ThrottlerGuard,
    ThrottlerStorage,
} from '@nestjs/throttler';
import { type Response } from 'express';

import { AppConfig } from '../../common/config/app-config';
import { secretFor } from '../../common/config/jwt-keys';
import { accessClaimsSchema } from '../../common/guards/jwt-auth.guard';

interface Window {
    limit: number;
    remaining: number;
    reset: number;
    policy: string;
}

@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
    constructor(
        @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
        @Inject(getStorageToken()) storageService: ThrottlerStorage,
        reflector: Reflector,
        private readonly jwt: JwtService,
        private readonly config: AppConfig,
    ) {
        super(options, storageService, reflector);
    }

    protected override async getTracker(req: Record<string, unknown>): Promise<string> {
        const userId = await this.principalOf(req);

        return userId ? `user:${userId}` : super.getTracker(req);
    }

    private async principalOf(req: Record<string, unknown>): Promise<string | undefined> {
        const headers = req['headers'] as Record<string, string | undefined> | undefined;
        const [scheme, token] = (headers?.['authorization'] ?? '').split(' ');

        if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;

        try {
            const secret = secretFor(this.jwt, token, this.config.auth.access);

            if (!secret) return undefined;

            const payload: unknown = await this.jwt.verifyAsync(token, {
                secret,
                issuer: this.config.auth.issuer,
                audience: this.config.auth.audience,
            });
            const parsed = accessClaimsSchema.safeParse(payload);

            return parsed.success ? parsed.data.sub : undefined;
        } catch {
            return undefined;
        }
    }

    protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
        const { context, limit, ttl, throttler } = requestProps;
        const response = context.switchToHttp().getResponse<Response>();
        const ttlSeconds = Math.max(1, Math.ceil(ttl / 1000));
        try {
            return await super.handleRequest(requestProps);
        } finally {
            const suffix = throttler.name === 'default' ? '' : `-${throttler.name}`;
            const remaining = Number(response.getHeader(`X-RateLimit-Remaining${suffix}`));
            const reset = Number(response.getHeader(`X-RateLimit-Reset${suffix}`));
            const retryAfter = Number(response.getHeader(`Retry-After${suffix}`));
            const window: Window = {
                limit,
                remaining: Number.isFinite(remaining) ? remaining : 0,
                reset: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : reset,
                policy: `${limit};w=${ttlSeconds}`,
            };
            RateLimitGuard.publish(context, response, window);
        }
    }

    private static publish(context: ExecutionContext, response: Response, window: Window): void {
        const request = context.switchToHttp().getRequest<{ rate_limit?: Window }>();
        const current = request.rate_limit;

        if (!current || window.remaining < current.remaining) request.rate_limit = window;

        const tightest = request.rate_limit ?? window;
        response.setHeader('RateLimit-Limit', String(tightest.limit));
        response.setHeader('RateLimit-Remaining', String(Math.max(0, tightest.remaining)));
        response.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil(tightest.reset))));
        response.setHeader('RateLimit-Policy', tightest.policy);
    }
}
