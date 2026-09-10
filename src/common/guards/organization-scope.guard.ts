import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';

import { type RequestWithUser } from '../decorators/current-user.decorator';
import {
    ORGANIZATION_SCOPE_KEY,
    type OrganizationScopeOptions,
} from '../decorators/organization-scope.decorator';
import { ROLES } from '../decorators/roles.decorator';
import { ApiError } from '../http/api-error';
import { type ErrorCode } from '../i18n/messages';
import { objectIdSchema } from '../zod/primitives';
import { ScopeResolverRegistry } from './scope-resolver.registry';

const NOT_FOUND_BY_KIND = {
    category: 'CATEGORY_NOT_FOUND',
    service: 'SERVICE_NOT_FOUND',
    news: 'NEWS_NOT_FOUND',
    infosection: 'INFOSECTION_NOT_FOUND',
    image: 'IMAGE_NOT_FOUND',
    archive: 'ARCHIVE_NOT_FOUND',
} as const;

/**
 * A `common-admin` may only act on organizations listed in their `organization_ids`; super-admins
 * bypass the check and citizens never pass. An entity scope loads the entity only to find its
 * organization — the handler re-reads what it needs, inside its own transaction where it matters.
 */
@Injectable()
export class OrganizationScopeGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly registry: ScopeResolverRegistry,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const options = this.reflector.get<OrganizationScopeOptions | undefined>(
            ORGANIZATION_SCOPE_KEY,
            context.getHandler(),
        );

        if (!options) return true;

        const request = context.switchToHttp().getRequest<Request & RequestWithUser>();
        const { user } = request;

        if (!user) throw ApiError.unauthorized('UNAUTHENTICATED');

        const organizationId = await this.resolveOrganizationId(request, options);

        if (user.role === ROLES.SUPER_ADMIN) return true;

        if (user.role !== ROLES.COMMON_ADMIN) throw ApiError.forbidden('FORBIDDEN');

        if (!user.organization_ids.includes(organizationId)) throw ApiError.forbidden('FORBIDDEN');

        return true;
    }

    private async resolveOrganizationId(
        request: Request & RequestWithUser,
        options: OrganizationScopeOptions,
    ): Promise<string> {
        switch (options.from) {
            case 'path': {
                const raw = request.params[options.param ?? 'id'];

                return this.parseId(raw, 'ORGANIZATION_NOT_FOUND');
            }
            case 'body': {
                const body = request.body as Record<string, unknown> | undefined;
                const raw = body?.[options.field ?? 'organization_id'];
                const parsed = objectIdSchema.safeParse(raw);

                if (!parsed.success) {
                    throw ApiError.badRequest('VALIDATION_ERROR', [
                        { path: options.field ?? 'organization_id', message: 'Must be a valid object id' },
                    ]);
                }

                return parsed.data;
            }
            case 'entity': {
                const id = this.parseId(
                    request.params[options.param ?? 'id'],
                    NOT_FOUND_BY_KIND[options.entity],
                );
                const entity = await this.registry.resolve(options.entity, id);

                if (!entity) throw ApiError.notFound(NOT_FOUND_BY_KIND[options.entity]);

                return entity.organization_id;
            }
            default:
                throw ApiError.forbidden('FORBIDDEN');
        }
    }

    private parseId(raw: unknown, code: ErrorCode): string {
        const parsed = objectIdSchema.safeParse(raw);

        if (!parsed.success) throw ApiError.notFound(code);

        return parsed.data;
    }
}
