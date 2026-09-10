import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { AnalyticsEvent } from './schemas/analytics-event.schema';

export type AnalyticsEventEntity = Lean<AnalyticsEvent>;

@Injectable()
export class AnalyticsRepository extends BaseRepository<AnalyticsEvent> {
    constructor(@InjectModel(AnalyticsEvent.name) model: Model<AnalyticsEvent>) {
        super(model);
    }
}
