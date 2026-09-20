import { SetMetadata } from '@nestjs/common';

export const ORGANIZATION_SCOPE_KEY = 'smart_city:organization_scope';

export type ScopedEntityKind = 'category' | 'service' | 'news' | 'infosection' | 'image' | 'archive';

/** `path`: the path param is the id; `body`: `organization_id` in the body; `entity`: load `:param` and read its `organization_id`. */
export type OrganizationScopeOptions =
    | { from: 'path'; param?: string }
    | { from: 'body'; field?: string }
    | { from: 'entity'; entity: ScopedEntityKind; param?: string };

export const OrganizationScope = (options: OrganizationScopeOptions): MethodDecorator =>
    SetMetadata(ORGANIZATION_SCOPE_KEY, options);
