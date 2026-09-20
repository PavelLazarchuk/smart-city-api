import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, type Model, Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { CascadeRegistry } from '../common/cascade/cascade.registry';
import { AppConfig } from '../common/config/app-config';
import { TransactionRunner } from '../common/database/transaction-runner';
import { AnalyticsEvent } from '../modules/analytics/schemas/analytics-event.schema';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { JobRunner } from './job-runner';

export const CASCADE_RECONCILE_JOB = 'cascade_reconcile';

export interface ReconcileResult {
    dangling_organizations: number;
    /** Rows a cascade hook removed or detached, per collection. */
    reconciled: Record<string, number>;
    /** Rows still pointing at a dangling organization: no hook claims them, so they stay. */
    left_behind: Record<string, number>;
    /** True when the findings were too large to be orphans and nothing was touched. */
    refused: boolean;
}

/** The two shapes a reference to an organization takes: one id, or the membership array on a user. */
const PARENT_FIELDS = ['organization_id', 'organization_ids'] as const;

/** Analytics events outlive their organization by design (own TTL, no hook), so they are not a reference. */
const HISTORICAL_MODELS: readonly string[] = [AnalyticsEvent.name];

/**
 * Safety net for organization deletion: children left by a migration, a shell session or a partial restore.
 * Detection reads every collection with an `organization_id`, but deletion goes through the registered hooks;
 * anything no hook claims is reported as `left_behind` rather than deleted.
 */
@Injectable()
export class CascadeReconcileJob {
    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly organizations: OrganizationsService,
        private readonly cascade: CascadeRegistry,
        private readonly config: AppConfig,
        private readonly tx: TransactionRunner,
        private readonly runner: JobRunner,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(CascadeReconcileJob.name);
    }

    run(): Promise<unknown> {
        return this.runner.run(CASCADE_RECONCILE_JOB, () => this.execute());
    }

    async execute(): Promise<ReconcileResult> {
        const dangling = await this.danglingOrganizations();

        if (dangling.length === 0)
            return { dangling_organizations: 0, reconciled: {}, left_behind: {}, refused: false };

        const before = await this.countRows(dangling);

        /**
         * An empty or half-restored `organizations` collection would make every child look like an orphan, so past
         * the configured count the job deletes nothing.
         */
        if (dangling.length > this.config.jobs.cascadeReconcileLimit) {
            this.logger.error(
                { dangling: dangling.length, limit: this.config.jobs.cascadeReconcileLimit, rows: before },
                'cascade reconcile refused: too many organizations look dangling to be orphans',
            );

            return {
                dangling_organizations: dangling.length,
                reconciled: {},
                left_behind: before,
                refused: true,
            };
        }

        this.logger.warn(
            { organization_ids: dangling, rows: before },
            'orphaned rows found: organizations that no longer exist still have children',
        );

        for (const id of dangling) {
            await this.tx.run((ctx) => this.cascade.run('organization', id, ctx));
        }

        const after = await this.countRows(dangling);
        const reconciled: Record<string, number> = {};

        for (const [collection, count] of Object.entries(before)) {
            const left = after[collection] ?? 0;

            if (count > left) reconciled[collection] = count - left;
        }

        if (Object.keys(after).length > 0)
            this.logger.warn({ rows: after }, 'orphaned rows no cascade hook claims were left in place');

        return { dangling_organizations: dangling.length, reconciled, left_behind: after, refused: false };
    }

    private async danglingOrganizations(): Promise<string[]> {
        const referenced = new Set<string>();

        for (const { model, field } of this.children()) {
            const ids: unknown[] = await model.distinct(field);

            for (const id of ids) {
                if (id instanceof Types.ObjectId) referenced.add(id.toHexString());
            }
        }

        if (referenced.size === 0) return [];

        const ids = [...referenced];
        const alive = await this.organizations.existingIds(ids);

        return ids.filter((id) => !alive.has(id));
    }

    private async countRows(organizationIds: string[]): Promise<Record<string, number>> {
        const ids = organizationIds.map((id) => new Types.ObjectId(id));
        const counts: Record<string, number> = {};

        for (const { model, field } of this.children()) {
            const count = await model.countDocuments({ [field]: { $in: ids } }).exec();

            if (count > 0) counts[model.collection.collectionName] = count;
        }

        return counts;
    }

    private children(): { model: Model<unknown>; field: string }[] {
        const children: { model: Model<unknown>; field: string }[] = [];

        // `connection.models` is typed as `Model<any>`; every use below is through the schema only.
        const models = Object.values(this.connection.models) as Model<unknown>[];

        for (const model of models) {
            if (HISTORICAL_MODELS.includes(model.modelName)) continue;

            const field = PARENT_FIELDS.find((candidate) => model.schema.path(candidate) !== undefined);

            if (field) children.push({ model, field });
        }

        return children;
    }
}
