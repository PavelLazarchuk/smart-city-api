import { SetMetadata } from '@nestjs/common';

export const ORGANIZATION_SCOPE_KEY = 'smart_city:organization_scope';

export type ScopedEntityKind = 'category' | 'service' | 'news' | 'infosection' | 'image' | 'archive';

/**
 * How the `OrganizationScopeGuard` finds the organization a request targets:
 * - `path`: the `:param` path parameter is the organization id;
 * - `body`: `organization_id` in the request body;
 * - `entity`: load the entity `:param` of the given kind and read its `organization_id`.
 */
export type OrganizationScopeOptions =
    | { from: 'path'; param?: string }
    | { from: 'body'; field?: string }
    | { from: 'entity'; entity: ScopedEntityKind; param?: string };

export const OrganizationScope = (options: OrganizationScopeOptions): MethodDecorator =>
    SetMetadata(ORGANIZATION_SCOPE_KEY, options);
