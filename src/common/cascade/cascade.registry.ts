import { Injectable } from '@nestjs/common';

import { type TransactionContext } from '../database/transaction-runner';
import { type AuthUser } from '../decorators/current-user.decorator';

export type CascadeParent = 'organization' | 'category' | 'service' | 'user';

export type CascadeHook = (parentId: string, ctx: TransactionContext) => Promise<void>;

export type RetireParent = 'organization' | 'service';

export interface RetireOptions {
    actor: AuthUser | null;
    cancelBookings: boolean;
}

export type RetireHook = (parentId: string, ctx: TransactionContext, options: RetireOptions) => Promise<void>;

/** Children register their own cleanup so no parent imports them; hooks run in the parent's transaction. */
@Injectable()
export class CascadeRegistry {
    private readonly hooks = new Map<CascadeParent, { name: string; hook: CascadeHook }[]>();
    private readonly retireHooks = new Map<RetireParent, RetireHook[]>();

    register(parent: CascadeParent, name: string, hook: CascadeHook): void {
        const list = this.hooks.get(parent) ?? [];
        list.push({ name, hook });
        this.hooks.set(parent, list);
    }

    registerRetire(parent: RetireParent, hook: RetireHook): void {
        this.retireHooks.set(parent, [...(this.retireHooks.get(parent) ?? []), hook]);
    }

    async run(parent: CascadeParent, parentId: string, ctx: TransactionContext): Promise<string[]> {
        const executed: string[] = [];

        for (const { name, hook } of this.hooks.get(parent) ?? []) {
            await hook(parentId, ctx);
            executed.push(name);
        }

        return executed;
    }

    async retire(
        parent: RetireParent,
        parentId: string,
        ctx: TransactionContext,
        options: RetireOptions,
    ): Promise<void> {
        for (const hook of this.retireHooks.get(parent) ?? []) await hook(parentId, ctx, options);
    }

    registered(parent: CascadeParent): string[] {
        return (this.hooks.get(parent) ?? []).map((entry) => entry.name);
    }
}
