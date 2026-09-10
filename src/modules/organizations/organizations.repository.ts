import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, type PipelineStage, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { type OrganizationInclude } from './dto/organization.schemas';
import { Organization } from './schemas/organization.schema';

export type OrganizationEntity = Lean<Organization>;

export interface OrganizationCounts {
    news: number;
    infosections: number;
    categories: number;
    services: number;
    images: number;
}

export type OrganizationListRow = OrganizationEntity & { counts: OrganizationCounts } & Partial<
        Record<OrganizationInclude, unknown[]>
    >;

export interface OrganizationTreeRow extends OrganizationEntity {
    news: unknown[];
    infosections: unknown[];
    categories: unknown[];
    services: unknown[];
    images: unknown[];
}

const CHILD_COLLECTIONS: Record<OrganizationInclude, { from: string; sort: Record<string, 1 | -1> }> = {
    news: { from: 'news', sort: { position: 1, _id: 1 } },
    infosections: { from: 'infosections', sort: { position: 1, _id: 1 } },
    categories: { from: 'categories', sort: { position: 1, _id: 1 } },
    services: { from: 'services', sort: { category_id: 1, position: 1, _id: 1 } },
    images: { from: 'images', sort: { created_at: -1, _id: 1 } },
};

function countLookup(include: OrganizationInclude): PipelineStage.Lookup {
    return {
        $lookup: {
            from: CHILD_COLLECTIONS[include].from,
            let: { organization_id: '$_id' },
            pipeline: [
                { $match: { $expr: { $eq: ['$organization_id', '$$organization_id'] } } },
                { $count: 'count' },
            ],
            as: `count_${include}`,
        },
    };
}

function rowsLookup(include: OrganizationInclude, limit: number): PipelineStage.Lookup {
    const { from, sort } = CHILD_COLLECTIONS[include];

    return {
        $lookup: {
            from,
            let: { organization_id: '$_id' },
            pipeline: [
                { $match: { $expr: { $eq: ['$organization_id', '$$organization_id'] } } },
                { $sort: sort },
                { $limit: limit },
            ],
            as: include,
        },
    };
}

@Injectable()
export class OrganizationsRepository extends BaseRepository<Organization> {
    constructor(@InjectModel(Organization.name) model: Model<Organization>) {
        super(model);
    }

    /**
     * One aggregation + a parallel count: match/sort/skip/limit on indexed fields first,
     * then per-child `$lookup` sub-pipelines with `$count` for the page's rows only.
     */
    async list(
        filter: FilterQuery<Organization>,
        pagination: ResolvedPagination,
        options: { empty: boolean; include: OrganizationInclude[]; includeLimit: number },
    ): Promise<PaginatedResult<OrganizationListRow>> {
        const includes = [...new Set(options.include)];
        const emptyStages: PipelineStage[] = options.empty
            ? [
                  ...(['news', 'infosections', 'categories', 'services'] as const).map(
                      (include): PipelineStage.Lookup => ({
                          $lookup: {
                              from: CHILD_COLLECTIONS[include].from,
                              let: { organization_id: '$_id' },
                              pipeline: [
                                  { $match: { $expr: { $eq: ['$organization_id', '$$organization_id'] } } },
                                  { $limit: 1 },
                              ],
                              as: `any_${include}`,
                          },
                      }),
                  ),
                  {
                      $match: {
                          any_news: { $size: 0 },
                          any_infosections: { $size: 0 },
                          any_categories: { $size: 0 },
                          any_services: { $size: 0 },
                      },
                  },
                  { $project: { any_news: 0, any_infosections: 0, any_categories: 0, any_services: 0 } },
              ]
            : [];

        const base: PipelineStage[] = [{ $match: filter }, ...emptyStages];
        const pagePipeline: PipelineStage[] = [
            ...base,
            { $sort: pagination.sort },
            { $skip: pagination.skip },
            { $limit: pagination.limit },
            ...(Object.keys(CHILD_COLLECTIONS) as OrganizationInclude[]).map(countLookup),
            ...includes.map((include) => rowsLookup(include, options.includeLimit)),
            {
                $addFields: {
                    counts: Object.fromEntries(
                        (Object.keys(CHILD_COLLECTIONS) as OrganizationInclude[]).map((include) => [
                            include,
                            { $ifNull: [{ $arrayElemAt: [`$count_${include}.count`, 0] }, 0] },
                        ]),
                    ),
                },
            },
            {
                $project: Object.fromEntries(
                    (Object.keys(CHILD_COLLECTIONS) as OrganizationInclude[]).map((include) => [
                        `count_${include}`,
                        0,
                    ]),
                ),
            },
        ];
        const countPipeline: PipelineStage[] = [...base, { $count: 'total' }];

        const [items, totals] = await Promise.all([
            this.aggregate<OrganizationListRow>(pagePipeline),
            this.aggregate<{ total: number }>(countPipeline),
        ]);

        return { items, total: totals[0]?.total ?? 0, page: pagination.page, limit: pagination.limit };
    }

    /**
     * The tree in one aggregation; services are split by category in the service layer.
     *
     * The result is a single document under the 16 MB BSON limit, so every child list is capped at
     * `limit` and services drop their booking documents. Occupancy survives as `booked_count`; the full
     * booking list has its own paginated routes.
     */
    async findTree(id: string, limit: number): Promise<OrganizationTreeRow | null> {
        if (!Types.ObjectId.isValid(id)) return null;

        const rows = await this.aggregate<OrganizationTreeRow>([
            { $match: { _id: new Types.ObjectId(id) } },
            ...(Object.keys(CHILD_COLLECTIONS) as OrganizationInclude[]).map((include) => ({
                $lookup: {
                    from: CHILD_COLLECTIONS[include].from,
                    let: { organization_id: '$_id' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$organization_id', '$$organization_id'] } } },
                        { $sort: CHILD_COLLECTIONS[include].sort },
                        { $limit: limit },
                        ...(include === 'services'
                            ? [
                                  {
                                      $project: {
                                          'options.slots.value.bookings': 0,
                                          'options.slots.value.time.bookings': 0,
                                      },
                                  },
                              ]
                            : []),
                    ],
                    as: include,
                },
            })),
        ]);

        return rows[0] ?? null;
    }

    async countExisting(ids: string[]): Promise<number> {
        return this.count({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } });
    }

    findAllForReport(): Promise<OrganizationEntity[]> {
        return this.findMany({ main_category: { $exists: true, $nin: [null, ''] } }, { _id: 1 });
    }
}
