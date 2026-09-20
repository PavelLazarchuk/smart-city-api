import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { AnalyticsEvent } from './schemas/analytics-event.schema';

export type AnalyticsEventEntity = Lean<AnalyticsEvent>;

@Injectable()
export class AnalyticsRepository extends BaseRepository<AnalyticsEvent> {
    constructor(@InjectModel(AnalyticsEvent.name) model: Model<AnalyticsEvent>) {
        super(model);
    }

    /** A deleted account's events are stripped of identity, not deleted: counts stay comparable across periods. */
    async anonymizeUser(userId: string, session?: ClientSession): Promise<number> {
        const result = await this.model
            .updateMany(
                { user_id: new Types.ObjectId(userId) },
                { $unset: { user_id: 1, user_name: 1, user_phone: 1 } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }
}
