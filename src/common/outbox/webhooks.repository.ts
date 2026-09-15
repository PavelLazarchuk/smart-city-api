import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../database/base.repository';
import { type PaginatedResult } from '../pagination/paginated-result';
import { type ResolvedPagination } from '../pagination/pagination.service';
import { type OutboxEventType } from './schemas/outbox-event.schema';
import { Webhook } from './schemas/webhook.schema';

export type WebhookEntity = Lean<Webhook>;
export type WebhookWithSecret = WebhookEntity & { secret: string };

@Injectable()
export class WebhooksRepository extends BaseRepository<Webhook> {
    constructor(@InjectModel(Webhook.name) model: Model<Webhook>) {
        super(model);
    }

    subscribers(type: OutboxEventType, organizationId: Types.ObjectId | null): Promise<WebhookWithSecret[]> {
        const scope: FilterQuery<Webhook>[] = [{ organization_id: null }];

        if (organizationId) scope.push({ organization_id: organizationId });

        return this.model
            .find({ enabled: true, events: type, $or: scope })
            .select('+secret')
            .lean<WebhookWithSecret[]>()
            .exec();
    }

    findWithSecret(id: string, session?: ClientSession): Promise<WebhookWithSecret | null> {
        if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);

        return this.model
            .findById(id)
            .select('+secret')
            .session(session ?? null)
            .lean<WebhookWithSecret>()
            .exec();
    }

    list(
        filter: FilterQuery<Webhook>,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<WebhookEntity>> {
        return this.paginate(filter, pagination);
    }

    async recordOutcome(id: Types.ObjectId, ok: boolean, error?: string): Promise<void> {
        const now = new Date();
        await this.model
            .updateOne(
                { _id: id },
                ok
                    ? { $set: { last_delivery_at: now, consecutive_failures: 0 }, $unset: { last_error: 1 } }
                    : {
                          $set: { last_failure_at: now, last_error: error },
                          $inc: { consecutive_failures: 1 },
                      },
            )
            .exec();
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
