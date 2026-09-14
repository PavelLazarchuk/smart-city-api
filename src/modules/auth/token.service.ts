import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AppConfig } from '../../common/config/app-config';
import { secretFor } from '../../common/config/jwt-keys';
import { type Role, ROLE_VALUES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';

export const refreshClaimsSchema = z.object({
    sub: z.string().min(1),
    sid: z.string().min(1),
    type: z.literal('refresh'),
});
export type RefreshClaims = z.infer<typeof refreshClaimsSchema>;

export interface IssuedPair {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_expires_at: Date;
}

@Injectable()
export class TokenService {
    constructor(
        private readonly jwt: JwtService,
        private readonly config: AppConfig,
    ) {}

    async issuePair(user: { id: string; role: Role }, sid: string): Promise<IssuedPair> {
        const { access: accessKeys, refresh: refreshKeys, issuer, audience } = this.config.auth;
        const accessToken = await this.jwt.signAsync(
            { sub: user.id, role: user.role, sid, type: 'access' },
            {
                secret: accessKeys.secret,
                keyid: accessKeys.kid,
                issuer,
                audience,
                expiresIn: this.config.auth.accessTtlSeconds,
            },
        );
        const refreshToken = await this.jwt.signAsync(
            { sub: user.id, sid, type: 'refresh' },
            {
                secret: refreshKeys.secret,
                keyid: refreshKeys.kid,
                issuer,
                audience,
                expiresIn: this.config.auth.refreshTtlSeconds,
            },
        );
        const access = this.decode(accessToken);
        const refresh = this.decode(refreshToken);

        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: Math.max(0, access.exp - access.iat),
            refresh_expires_at: new Date(refresh.exp * 1000),
        };
    }

    async verifyRefresh(token: string): Promise<RefreshClaims> {
        let payload: unknown;
        try {
            const secret = secretFor(this.jwt, token, this.config.auth.refresh);

            if (!secret) throw ApiError.unauthorized('TOKEN_INVALID');

            payload = await this.jwt.verifyAsync(token, {
                secret,
                issuer: this.config.auth.issuer,
                audience: this.config.auth.audience,
            });
        } catch (error) {
            if (error instanceof ApiError) throw error;

            const name = (error as { name?: string }).name;
            throw ApiError.unauthorized(name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
        }
        const parsed = refreshClaimsSchema.safeParse(payload);

        if (!parsed.success) throw ApiError.unauthorized('TOKEN_INVALID');

        return parsed.data;
    }

    hashRefreshToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    private decode(token: string): { exp: number; iat: number } {
        const decoded = this.jwt.decode<{ exp?: number; iat?: number } | null>(token);

        return { exp: decoded?.exp ?? 0, iat: decoded?.iat ?? 0 };
    }

    static isRole(value: unknown): value is Role {
        return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
    }
}
