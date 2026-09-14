import {
    type ClientSession,
    type FilterQuery,
    type Model,
    type PipelineStage,
    type ProjectionType,
    type UpdateQuery,
    Types,
} from 'mongoose';

import { type PaginatedResult } from '../pagination/paginated-result';
import { type ResolvedPagination } from '../pagination/pagination.service';

export type Lean<T> = T & { _id: Types.ObjectId; created_at: Date; updated_at: Date };

/** Shared Mongoose access patterns: every method takes an optional `ClientSession` and returns lean docs. */
export abstract class BaseRepository<TDoc> {
    protected constructor(protected readonly model: Model<TDoc>) {}

    toObjectId(id: string): Types.ObjectId {
        return new Types.ObjectId(id);
    }

    async findById(
        id: string,
        session?: ClientSession,
        projection?: ProjectionType<TDoc>,
    ): Promise<Lean<TDoc> | null> {
        if (!Types.ObjectId.isValid(id)) return null;

        return this.model
            .findById(id, projection)
            .session(session ?? null)
            .lean<Lean<TDoc>>()
            .exec();
    }

    async findOne(filter: FilterQuery<TDoc>, session?: ClientSession): Promise<Lean<TDoc> | null> {
        return this.model
            .findOne(filter)
            .session(session ?? null)
            .lean<Lean<TDoc>>()
            .exec();
    }

    async findMany(
        filter: FilterQuery<TDoc>,
        sort?: Record<string, 1 | -1>,
        session?: ClientSession,
    ): Promise<Lean<TDoc>[]> {
        return this.model
            .find(filter)
            .sort(sort ?? { _id: 1 })
            .session(session ?? null)
            .lean<Lean<TDoc>[]>()
            .exec();
    }

    async count(filter: FilterQuery<TDoc>, session?: ClientSession): Promise<number> {
        return this.model
            .countDocuments(filter)
            .session(session ?? null)
            .exec();
    }

    async exists(filter: FilterQuery<TDoc>, session?: ClientSession): Promise<boolean> {
        const found = await this.model
            .exists(filter)
            .session(session ?? null)
            .exec();

        return found !== null;
    }

    async create(data: Partial<TDoc>, session?: ClientSession): Promise<Lean<TDoc>> {
        const [doc] = await this.model.create([data], { session });

        if (!doc) throw new Error('create returned no document');

        return doc.toObject() as Lean<TDoc>;
    }

    async updateById(
        id: string,
        update: UpdateQuery<TDoc>,
        session?: ClientSession,
    ): Promise<Lean<TDoc> | null> {
        return this.model
            .findByIdAndUpdate(id, update, { new: true, runValidators: true, session })
            .lean<Lean<TDoc>>()
            .exec();
    }

    async deleteById(id: string, session?: ClientSession): Promise<boolean> {
        if (!Types.ObjectId.isValid(id)) return false;

        const result = await this.model
            .deleteOne({ _id: this.toObjectId(id) })
            .session(session ?? null)
            .exec();

        return result.deletedCount > 0;
    }

    async deleteMany(filter: FilterQuery<TDoc>, session?: ClientSession): Promise<number> {
        const result = await this.model
            .deleteMany(filter)
            .session(session ?? null)
            .exec();

        return result.deletedCount;
    }

    async paginate(
        filter: FilterQuery<TDoc>,
        pagination: ResolvedPagination,
        projection?: ProjectionType<TDoc>,
    ): Promise<PaginatedResult<Lean<TDoc>>> {
        const [items, total] = await Promise.all([
            this.model
                .find(filter, projection)
                .sort(pagination.sort)
                .skip(pagination.skip)
                .limit(pagination.limit)
                .lean<Lean<TDoc>[]>()
                .exec(),
            this.model.countDocuments(filter).exec(),
        ]);

        return { items, total, page: pagination.page, limit: pagination.limit };
    }

    /**
     * Cursor pagination on `_id` descending for high-volume collections. `countDocuments` over the
     * whole match is the most expensive query of the page, so it runs only when `withTotal` asks.
     */
    async paginateByCursor(
        filter: FilterQuery<TDoc>,
        cursor: string | undefined,
        limit: number,
        withTotal = false,
    ): Promise<PaginatedResult<Lean<TDoc>>> {
        const cursorFilter = cursor ? { ...filter, _id: { $lt: new Types.ObjectId(cursor) } } : filter;
        const [rows, total] = await Promise.all([
            this.model
                .find(cursorFilter)
                .sort({ _id: -1 })
                .limit(limit + 1)
                .lean<Lean<TDoc>[]>()
                .exec(),
            withTotal ? this.model.countDocuments(filter).exec() : Promise.resolve(null),
        ]);
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items[items.length - 1];

        return { items, total, page: 1, limit, next_cursor: hasMore && last ? last._id.toHexString() : null };
    }

    async aggregate<TRow>(pipeline: PipelineStage[], session?: ClientSession): Promise<TRow[]> {
        return this.model
            .aggregate<TRow>(pipeline)
            .session(session ?? null)
            .exec();
    }
}
