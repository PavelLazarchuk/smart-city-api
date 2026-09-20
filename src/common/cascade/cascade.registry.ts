import { Injectable } from '@nestjs/common';

import { type TransactionContext } from '../database/transaction-runner';

export type CascadeParent = 'organization' | 'category' | 'service' | 'user';

export type CascadeHook = (parentId: string, ctx: TransactionContext) => Promise<void>;

/** Children register their own cleanup so no parent imports them; hooks run in the parent's transaction. */
@Injectable()
export class CascadeRegistry {
    private readonly hooks = new Map<CascadeParent, { name: string; hook: CascadeHook }[]>();

    register(parent: CascadeParent, name: string, hook: CascadeHook): void {
        const list = this.hooks.get(parent) ?? [];
        list.push({ name, hook });
        this.hooks.set(parent, list);
    }

    async run(parent: CascadeParent, parentId: string, ctx: TransactionContext): Promise<string[]> {
        const executed: string[] = [];

        for (const { name, hook } of this.hooks.get(parent) ?? []) {
            await hook(parentId, ctx);
            executed.push(name);
        }

        return executed;
    }

    registered(parent: CascadeParent): string[] {
        return (this.hooks.get(parent) ?? []).map((entry) => entry.name);
    }
}
