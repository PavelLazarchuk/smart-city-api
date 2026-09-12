import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { nextPosition, reorderSiblings } from '../../common/database/reorder';
import { News } from './schemas/news.schema';

export type NewsEntity = Lean<News>;

@Injectable()
export class NewsRepository extends BaseRepository<News> {
    constructor(@InjectModel(News.name) model: Model<News>) {
        super(model);
    }

    nextPosition(organizationId: string, session?: ClientSession): Promise<number> {
        return nextPosition(this.model, { organization_id: new Types.ObjectId(organizationId) }, session);
    }

    reorder(organizationId: string, ids: string[], session?: ClientSession): Promise<void> {
        return reorderSiblings(
            this.model,
            { organization_id: new Types.ObjectId(organizationId) },
            ids,
            session,
        );
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }

    imageReferences(): Promise<string[]> {
        return this.model.distinct('value.image_value').exec();
    }

    findExpired(now: Date, limit: number): Promise<NewsEntity[]> {
        return this.model
            .find({ expires_at: { $lte: now } })
            .limit(limit)
            .lean<NewsEntity[]>()
            .exec();
    }
}
