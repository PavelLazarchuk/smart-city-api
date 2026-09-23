import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
    type ClientSession,
    type FilterQuery,
    Model,
    type PipelineStage,
    type ProjectionType,
    Types,
} from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { SEARCH_FACET_LIMIT } from '../../common/config/constants';
import { nextPosition, reorderSiblings } from '../../common/database/reorder';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { type RecurrentDate, Service, type ServiceOption } from './schemas/service.schema';

export interface FacetBucket {
    value: string;
    count: number;
}

export interface ServiceFacets {
    tags: FacetBucket[];
    categories: FacetBucket[];
    organizations: FacetBucket[];
}

const LOOSE_MIN_LENGTH = 3;
const LOOSE_MAX_TERMS = 5;

function looseTerms(q: string): string[] {
    return [
        ...new Set(
            q
                .toLowerCase()
                .split(/[^\p{L}\p{N}]+/u)
                .filter((word) => word.length >= LOOSE_MIN_LENGTH),
        ),
    ]
        .slice(0, LOOSE_MAX_TERMS)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export type ServiceEntity = Lean<Service>;

@Injectable()
export class ServicesRepository extends BaseRepository<Service> {
    constructor(@InjectModel(Service.name) model: Model<Service>) {
        super(model);
    }

    nextPosition(
        organizationId: string,
        categoryId: string | null,
        session?: ClientSession,
    ): Promise<number> {
        return nextPosition(
            this.model,
            {
                organization_id: new Types.ObjectId(organizationId),
                category_id: categoryId ? new Types.ObjectId(categoryId) : null,
            },
            session,
        );
    }

    reorderDirect(organizationId: string, ids: string[], session?: ClientSession): Promise<void> {
        return reorderSiblings(
            this.model,
            { organization_id: new Types.ObjectId(organizationId), category_id: null },
            ids,
            session,
        );
    }

    reorderInCategory(categoryId: string, ids: string[], session?: ClientSession): Promise<void> {
        return reorderSiblings(this.model, { category_id: new Types.ObjectId(categoryId) }, ids, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }

    findIdsByOrganization(organizationId: string, session?: ClientSession): Promise<string[]> {
        return this.model
            .find({ organization_id: new Types.ObjectId(organizationId) }, { _id: 1 })
            .session(session ?? null)
            .lean<{ _id: Types.ObjectId }[]>()
            .exec()
            .then((rows) => rows.map((row) => row._id.toHexString()));
    }

    findByCategory(categoryId: string, session?: ClientSession): Promise<ServiceEntity[]> {
        return this.findMany({ category_id: new Types.ObjectId(categoryId) }, { position: 1 }, session);
    }

    async searchText(
        filter: FilterQuery<Service>,
        q: string,
        pagination: ResolvedPagination,
        projection?: ProjectionType<Service>,
    ): Promise<PaginatedResult<ServiceEntity>> {
        const textFilter: FilterQuery<Service> = { ...filter, $text: { $search: q } };
        const fields = {
            ...(projection as Record<string, unknown> | undefined),
            score: { $meta: 'textScore' },
        };
        const [items, total] = await Promise.all([
            this.model
                .find(textFilter, fields)
                .sort({ score: { $meta: 'textScore' }, _id: 1 })
                .skip(pagination.skip)
                .limit(pagination.limit)
                .lean<(ServiceEntity & { score?: number })[]>()
                .exec(),
            this.model.countDocuments(textFilter).exec(),
        ]);

        if (total > 0)
            return {
                items: items.map(({ score: _score, ...item }) => item as ServiceEntity),
                total,
                page: pagination.page,
                limit: pagination.limit,
            };

        return this.searchLoose(filter, q, pagination, projection);
    }

    private async searchLoose(
        filter: FilterQuery<Service>,
        q: string,
        pagination: ResolvedPagination,
        projection?: ProjectionType<Service>,
    ): Promise<PaginatedResult<ServiceEntity>> {
        const words = looseTerms(q);

        if (words.length === 0)
            return { items: [], total: 0, page: pagination.page, limit: pagination.limit };

        const loose: FilterQuery<Service> = {
            ...filter,
            $or: words.flatMap((word) => [
                { label: { $regex: word, $options: 'i' } },
                { description: { $regex: word, $options: 'i' } },
                { tags: { $regex: word, $options: 'i' } },
            ]),
        };
        const [items, total] = await Promise.all([
            this.model
                .find(loose, projection)
                .sort({ position: 1, _id: 1 })
                .skip(pagination.skip)
                .limit(pagination.limit)
                .lean<ServiceEntity[]>()
                .exec(),
            this.model.countDocuments(loose).exec(),
        ]);

        return { items, total, page: pagination.page, limit: pagination.limit };
    }

    async facets(filter: FilterQuery<Service>): Promise<ServiceFacets> {
        const top = (field: string): PipelineStage.FacetPipelineStage[] => [
            { $unwind: `$${field}` },
            { $group: { _id: `$${field}`, count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: SEARCH_FACET_LIMIT },
        ];
        const grouped = (field: string): PipelineStage.FacetPipelineStage[] => [
            { $match: { [field]: { $ne: null } } },
            { $group: { _id: `$${field}`, count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: SEARCH_FACET_LIMIT },
        ];
        const [row] = await this.aggregate<{
            tags: { _id: string; count: number }[];
            categories: { _id: Types.ObjectId; count: number }[];
            organizations: { _id: Types.ObjectId; count: number }[];
        }>([
            { $match: filter },
            {
                $facet: {
                    tags: top('tags'),
                    categories: grouped('category_id'),
                    organizations: grouped('organization_id'),
                },
            },
        ]);

        return {
            tags: (row?.tags ?? []).map((entry) => ({ value: entry._id, count: entry.count })),
            categories: (row?.categories ?? []).map((entry) => ({
                value: entry._id.toHexString(),
                count: entry.count,
            })),
            organizations: (row?.organizations ?? []).map((entry) => ({
                value: entry._id.toHexString(),
                count: entry.count,
            })),
        };
    }

    nearby(
        lng: number,
        lat: number,
        radiusM: number,
        limit: number,
        filter: FilterQuery<Service>,
        projection?: Record<string, 0 | 1>,
    ): Promise<(ServiceEntity & { distance_m: number })[]> {
        const stages: PipelineStage[] = [
            {
                $geoNear: {
                    near: { type: 'Point', coordinates: [lng, lat] },
                    distanceField: 'distance_m',
                    maxDistance: radiusM,
                    query: filter,
                    spherical: true,
                },
            },
            { $limit: limit },
        ];

        if (projection && Object.keys(projection).length > 0) stages.push({ $project: projection });

        return this.aggregate<ServiceEntity & { distance_m: number }>(stages);
    }

    slugTaken(
        organizationId: Types.ObjectId,
        slug: string,
        exceptId?: string,
        session?: ClientSession,
    ): Promise<boolean> {
        const filter: FilterQuery<Service> = { organization_id: organizationId, slug };

        if (exceptId) filter['_id'] = { $ne: new Types.ObjectId(exceptId) };

        return this.exists(filter, session);
    }

    findBySlug(
        organizationId: string,
        slug: string,
        projection?: ProjectionType<Service>,
    ): Promise<ServiceEntity | null> {
        if (!Types.ObjectId.isValid(organizationId)) return Promise.resolve(null);

        return this.model
            .findOne(
                { organization_id: new Types.ObjectId(organizationId), slug, deleted_at: null },
                projection,
            )
            .lean<ServiceEntity>()
            .exec();
    }

    findDeletedBefore(before: Date, limit: number): Promise<ServiceEntity[]> {
        return this.model
            .find({ deleted_at: { $ne: null, $lte: before } }, { _id: 1, organization_id: 1 })
            .limit(limit)
            .lean<ServiceEntity[]>()
            .exec();
    }

    findManyByIds(ids: string[]): Promise<ServiceEntity[]> {
        if (ids.length === 0) return Promise.resolve([]);

        return this.findMany({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { _id: 1 });
    }

    deleteByCategory(categoryId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ category_id: new Types.ObjectId(categoryId) }, session);
    }

    async pushOption(id: string, option: ServiceOption, session?: ClientSession): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id) },
            { $push: { options: option } },
            undefined,
            session,
        );
    }

    async setOptionFields(
        id: string,
        optionId: string,
        fields: Record<string, unknown>,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id), 'options.id': optionId },
            { $set: prefix('options.$[option]', fields) },
            [{ 'option.id': optionId }],
            session,
        );
    }

    async pullOption(id: string, optionId: string, session?: ClientSession): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id), 'options.id': optionId },
            { $pull: { options: { id: optionId } } },
            undefined,
            session,
        );
    }

    async setRecurrence(
        id: string,
        optionId: string,
        dates: RecurrentDate[] | null,
        session?: ClientSession,
    ): Promise<boolean> {
        const update =
            dates === null
                ? { $unset: { 'options.$[option].recurrent_dates': 1 } }
                : { $set: { 'options.$[option].recurrent_dates': dates } };

        return this.matched(
            { _id: new Types.ObjectId(id), 'options.id': optionId },
            update,
            [{ 'option.id': optionId }],
            session,
        );
    }

    findWithRecurrentOptions(): Promise<ServiceEntity[]> {
        return this.findMany(
            { 'options.recurrent_dates.0': { $exists: true }, deleted_at: null, status: { $ne: 'archived' } },
            { _id: 1 },
        );
    }

    findAllForDebtorReport(): Promise<ServiceEntity[]> {
        return this.projected({
            organization_id: 1,
            status: 1,
            deleted_at: 1,
            label: 1,
            'value.heading_value': 1,
            'options.id': 1,
            'options.service_type': 1,
            'options.enabled': 1,
            'options.recurrent_dates': 1,
        });
    }

    imageReferences(): Promise<string[]> {
        return this.model.distinct('value.image_value').exec();
    }

    async touch(id: string, session?: ClientSession): Promise<void> {
        await this.model
            .updateOne({ _id: new Types.ObjectId(id) }, { $set: { updated_at: new Date() } }, { session })
            .exec();
    }

    async cancelDeadlines(ids: string[], session?: ClientSession): Promise<Map<string, number | null>> {
        if (ids.length === 0) return new Map();

        const rows = await this.model
            .find(
                { _id: { $in: ids.map((id) => new Types.ObjectId(id)) } },
                { 'booking_policy.cancel_deadline_minutes': 1 },
            )
            .session(session ?? null)
            .lean<{ _id: Types.ObjectId; booking_policy?: { cancel_deadline_minutes?: number | null } }[]>()
            .exec();

        return new Map(
            rows.map((row) => [row._id.toHexString(), row.booking_policy?.cancel_deadline_minutes ?? null]),
        );
    }

    private projected(projection: Record<string, 0 | 1>): Promise<ServiceEntity[]> {
        return this.model.find({}, projection).lean<ServiceEntity[]>().exec();
    }

    private async matched(
        filter: FilterQuery<Service>,
        update: Record<string, unknown>,
        arrayFilters: Record<string, unknown>[] | undefined,
        session?: ClientSession,
    ): Promise<boolean> {
        const result = await this.model.updateOne(filter, update, { arrayFilters, session }).exec();

        return result.matchedCount === 1;
    }
}

function prefix(path: string, fields: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${path}.${key}`, value]));
}
