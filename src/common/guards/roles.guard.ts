import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { type RequestWithUser } from '../decorators/current-user.decorator';
import { type Role, ROLES_KEY } from '../decorators/roles.decorator';
import { ApiError } from '../http/api-error';

/** Answers 403, not 401, when the principal lacks the required role. */
@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (!roles || roles.length === 0) return true;

        const { user } = context.switchToHttp().getRequest<RequestWithUser>();

        if (!user) throw ApiError.unauthorized('UNAUTHENTICATED');

        if (!roles.includes(user.role)) throw ApiError.forbidden('FORBIDDEN');

        return true;
    }
}
