import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { type Response } from 'express';

interface Window {
    limit: number;
    remaining: number;
    reset: number;
    policy: string;
}

@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
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
