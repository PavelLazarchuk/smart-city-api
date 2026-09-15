import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { nextPosition, reorderSiblings } from '../../common/database/reorder';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
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

    async searchText(
        filter: FilterQuery<News>,
        q: string,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<NewsEntity>> {
        const textFilter: FilterQuery<News> = { ...filter, $text: { $search: q } };
        const [items, total] = await Promise.all([
            this.model
                .find(textFilter, { score: { $meta: 'textScore' } })
                .sort({ score: { $meta: 'textScore' }, _id: 1 })
                .skip(pagination.skip)
                .limit(pagination.limit)
                .lean<(NewsEntity & { score?: number })[]>()
                .exec(),
            this.model.countDocuments(textFilter).exec(),
        ]);

        return {
            items: items.map(({ score: _score, ...item }) => item as NewsEntity),
            total,
            page: pagination.page,
            limit: pagination.limit,
        };
    }

    slugTaken(organizationId: Types.ObjectId, slug: string, exceptId?: string): Promise<boolean> {
        const filter: FilterQuery<News> = { organization_id: organizationId, slug };

        if (exceptId) filter['_id'] = { $ne: new Types.ObjectId(exceptId) };

        return this.exists(filter);
    }

    findBySlug(organizationId: string, slug: string): Promise<NewsEntity | null> {
        if (!Types.ObjectId.isValid(organizationId)) return Promise.resolve(null);

        return this.findOne({ organization_id: new Types.ObjectId(organizationId), slug });
    }

    feed(filter: FilterQuery<News>, limit: number): Promise<NewsEntity[]> {
        return this.model.find(filter).sort({ date: -1, _id: -1 }).limit(limit).lean<NewsEntity[]>().exec();
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
