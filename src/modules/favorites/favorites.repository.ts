import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { Favorite, type FavoriteType } from './schemas/favorite.schema';

export type FavoriteEntity = Lean<Favorite>;

const DUPLICATE_KEY = 11000;

@Injectable()
export class FavoritesRepository extends BaseRepository<Favorite> {
    constructor(@InjectModel(Favorite.name) model: Model<Favorite>) {
        super(model);
    }

    has(userId: string, type: FavoriteType, targetId: string): Promise<boolean> {
        return this.exists({
            user_id: new Types.ObjectId(userId),
            type,
            target_id: new Types.ObjectId(targetId),
        });
    }

    countByUser(userId: string): Promise<number> {
        return this.count({ user_id: new Types.ObjectId(userId) });
    }

    async add(
        userId: string,
        type: FavoriteType,
        targetId: string,
        organizationId: Types.ObjectId,
    ): Promise<void> {
        try {
            await this.model
                .updateOne(
                    { user_id: new Types.ObjectId(userId), type, target_id: new Types.ObjectId(targetId) },
                    { $setOnInsert: { organization_id: organizationId } },
                    { upsert: true },
                )
                .exec();
        } catch (error) {
            if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
        }
    }

    remove(userId: string, type: FavoriteType, targetId: string): Promise<number> {
        return this.deleteMany({
            user_id: new Types.ObjectId(userId),
            type,
            target_id: new Types.ObjectId(targetId),
        });
    }

    listByUser(
        userId: string,
        type: FavoriteType | undefined,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<FavoriteEntity>> {
        const filter: FilterQuery<Favorite> = { user_id: new Types.ObjectId(userId) };

        if (type) filter['type'] = type;

        return this.paginate(filter, pagination);
    }

    deleteByUser(userId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ user_id: new Types.ObjectId(userId) }, session);
    }

    deleteByTarget(type: FavoriteType, targetId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ type, target_id: new Types.ObjectId(targetId) }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
