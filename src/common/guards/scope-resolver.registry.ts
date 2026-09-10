import { Injectable } from '@nestjs/common';

import { type ScopedEntityKind } from '../decorators/organization-scope.decorator';

export interface ScopedEntity {
    organization_id: string;
    [key: string]: unknown;
}

export type ScopeResolver = (id: string) => Promise<ScopedEntity | null>;

/**
 * Modules register how to load their entity by id so the `OrganizationScopeGuard` can resolve the
 * target organization "from the stored entity" without importing module internals.
 */
@Injectable()
export class ScopeResolverRegistry {
    private readonly resolvers = new Map<ScopedEntityKind, ScopeResolver>();

    register(kind: ScopedEntityKind, resolver: ScopeResolver): void {
        this.resolvers.set(kind, resolver);
    }

    resolve(kind: ScopedEntityKind, id: string): Promise<ScopedEntity | null> {
        const resolver = this.resolvers.get(kind);

        if (!resolver) throw new Error(`No scope resolver registered for "${kind}"`);

        return resolver(id);
    }
}
