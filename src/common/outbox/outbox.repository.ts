import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../database/base.repository';
import { type PaginatedResult } from '../pagination/paginated-result';
import { type ResolvedPagination } from '../pagination/pagination.service';
import { OutboxEvent, type OutboxDelivery } from './schemas/outbox-event.schema';

export type OutboxEventEntity = Lean<OutboxEvent>;

@Injectable()
export class OutboxRepository extends BaseRepository<OutboxEvent> {
    constructor(@InjectModel(OutboxEvent.name) model: Model<OutboxEvent>) {
        super(model);
    }

    claimNext(now: Date, leaseMs: number, session?: ClientSession): Promise<OutboxEventEntity | null> {
        return this.model
            .findOneAndUpdate(
                {
                    status: 'pending',
                    next_attempt_at: { $lte: now },
                    $or: [{ claimed_until: null }, { claimed_until: { $lte: now } }],
                },
                { $set: { claimed_until: new Date(now.getTime() + leaseMs) } },
                { sort: { next_attempt_at: 1, _id: 1 }, new: true, session },
            )
            .lean<OutboxEventEntity>()
            .exec();
    }

    async finish(
        id: Types.ObjectId,
        update: {
            status: OutboxEvent['status'];
            attempts: number;
            next_attempt_at: Date;
            deliveries: OutboxDelivery[];
            delivered_at?: Date;
            last_error?: string;
        },
    ): Promise<void> {
        await this.model
            .updateOne(
                { _id: id },
                {
                    $set: { ...update, claimed_until: null },
                    ...(update.delivered_at ? {} : { $unset: { delivered_at: 1 } }),
                },
            )
            .exec();
    }

    list(
        filter: FilterQuery<OutboxEvent>,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<OutboxEventEntity>> {
        return this.paginate(filter, pagination, { internal: 0 });
    }

    countDue(now: Date): Promise<number> {
        return this.count({ status: 'pending', next_attempt_at: { $lte: now } });
    }
}
