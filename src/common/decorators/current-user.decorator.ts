import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { type Role } from './roles.decorator';

/** The authenticated principal attached to the request by `JwtAuthGuard`. */
export interface AuthUser {
    id: string;
    role: Role;
    organization_ids: string[];
    sid: string;
    name?: string;
    phone?: string;
    login?: string;
}

export interface RequestWithUser {
    user?: AuthUser;
}

export const CurrentUser = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
        const request = ctx.switchToHttp().getRequest<RequestWithUser>();

        return request.user;
    },
);
