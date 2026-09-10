import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type Request } from 'express';
import { z } from 'zod';

import { AppConfig } from '../config/app-config';
import { RequestContext } from '../context/request-context';
import { type RequestWithUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLE_VALUES } from '../decorators/roles.decorator';
import { ApiError } from '../http/api-error';
import { AUTH_USER_RESOLVER, type AuthUserResolver } from './auth-user.resolver';

export const accessClaimsSchema = z.object({
    sub: z.string().min(1),
    sid: z.string().min(1),
    role: z.enum(ROLE_VALUES),
    type: z.literal('access'),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

/**
 * Verifies the bearer access token and attaches the principal. Public routes pass without a token
 * but still get the principal when a valid token is present (role-aware masking).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly jwt: JwtService,
        private readonly config: AppConfig,
        @Inject(AUTH_USER_RESOLVER) private readonly users: AuthUserResolver,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        const request = context.switchToHttp().getRequest<Request & RequestWithUser>();
        const token = this.extractToken(request);

        if (!token) {
            if (isPublic) return true;

            throw ApiError.unauthorized('UNAUTHENTICATED');
        }

        const claims = await this.verify(token, isPublic);

        if (!claims) return true;

        const user = await this.users.resolve(claims.sub, claims.sid);

        if (!user) {
            if (isPublic) return true;

            throw ApiError.unauthorized('SESSION_REVOKED');
        }

        request.user = user;
        const store = RequestContext.get();

        if (store) store.user_id = user.id;

        return true;
    }

    private extractToken(request: Request): string | undefined {
        const header = request.headers.authorization;

        if (!header) return undefined;

        const [scheme, value] = header.split(' ');

        if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;

        return value;
    }

    private async verify(token: string, lenient: boolean): Promise<AccessClaims | undefined> {
        try {
            const payload: unknown = await this.jwt.verifyAsync(token, {
                secret: this.config.auth.accessSecret,
            });
            const parsed = accessClaimsSchema.safeParse(payload);

            if (!parsed.success) throw ApiError.unauthorized('TOKEN_INVALID');

            return parsed.data;
        } catch (error) {
            if (lenient) return undefined;

            if (error instanceof ApiError) throw error;

            const name = (error as { name?: string }).name;
            throw ApiError.unauthorized(name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
        }
    }
}
