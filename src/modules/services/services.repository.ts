import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
    type AnyBulkWriteOperation,
    type ClientSession,
    type FilterQuery,
    Model,
    type PipelineStage,
    type ProjectionType,
    Types,
} from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { nextPosition, reorderSiblings } from '../../common/database/reorder';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import {
    type RecurrentDate,
    Service,
    type ServiceOption,
    type Slot,
    type TimeEntry,
} from './schemas/service.schema';
import { type RecurrentSlotPlan } from './slot.logic';

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

        return {
            items: items.map(({ score: _score, ...item }) => item as ServiceEntity),
            total,
            page: pagination.page,
            limit: pagination.limit,
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

    async pushSlot(id: string, optionId: string, slot: Slot, session?: ClientSession): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id), 'options.id': optionId },
            { $push: { 'options.$[option].slots': slot } },
            [{ 'option.id': optionId }],
            session,
        );
    }

    async setSlotFields(
        id: string,
        optionId: string,
        slotId: string,
        fields: Record<string, unknown>,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id) },
            { $set: prefix('options.$[option].slots.$[slot]', fields) },
            [{ 'option.id': optionId }, { 'slot.id': slotId }],
            session,
        );
    }

    async pullSlots(
        serviceId: string,
        optionId: string,
        slotIds: string[],
        session?: ClientSession,
    ): Promise<boolean> {
        if (slotIds.length === 0) return false;

        return this.matched(
            { _id: new Types.ObjectId(serviceId) },
            { $pull: { 'options.$[option].slots': { id: { $in: slotIds } } } },
            [{ 'option.id': optionId }],
            session,
        );
    }

    /** Adds time entries to a `date_time` slot without rewriting the ones already there. */
    async pushTimes(
        id: string,
        optionId: string,
        slotId: string,
        entries: TimeEntry[],
        session?: ClientSession,
    ): Promise<boolean> {
        if (entries.length === 0) return false;

        return this.matched(
            { _id: new Types.ObjectId(id) },
            { $push: { 'options.$[option].slots.$[slot].value.time': { $each: entries } } },
            [{ 'option.id': optionId }, { 'slot.id': slotId }],
            session,
        );
    }

    async pullTimes(
        id: string,
        optionId: string,
        slotId: string,
        times: string[],
        session?: ClientSession,
    ): Promise<boolean> {
        if (times.length === 0) return false;

        return this.matched(
            { _id: new Types.ObjectId(id) },
            { $pull: { 'options.$[option].slots.$[slot].value.time': { time: { $in: times } } } },
            [{ 'option.id': optionId }, { 'slot.id': slotId }],
            session,
        );
    }

    async setTimeLimit(
        id: string,
        optionId: string,
        slotId: string,
        time: string,
        limit: number | null,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id) },
            { $set: { 'options.$[option].slots.$[slot].value.time.$[entry].limit': limit } },
            [{ 'option.id': optionId }, { 'slot.id': slotId }, { 'entry.time': time }],
            session,
        );
    }

    async renameTimes(
        id: string,
        optionId: string,
        slotId: string,
        moves: [string, string][],
        session?: ClientSession,
    ): Promise<number> {
        if (moves.length === 0) return 0;

        const result = await this.model.bulkWrite(
            moves.map(([from, to]) => ({
                updateOne: {
                    filter: { _id: new Types.ObjectId(id) },
                    update: { $set: { 'options.$[option].slots.$[slot].value.time.$[entry].time': to } },
                    arrayFilters: [{ 'option.id': optionId }, { 'slot.id': slotId }, { 'entry.time': from }],
                },
            })),
            { session, ordered: true },
        );

        return result.modifiedCount;
    }

    async clearSlotCount(
        id: string,
        optionId: string,
        slotId: string,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            { _id: new Types.ObjectId(id) },
            { $set: { 'options.$[option].slots.$[slot].value.booked_count': 0 } },
            [{ 'option.id': optionId }, { 'slot.id': slotId }],
            session,
        );
    }

    async clearTimeCounts(
        id: string,
        optionId: string,
        slotId: string,
        time: string | undefined,
        session?: ClientSession,
    ): Promise<boolean> {
        const path = time
            ? 'options.$[option].slots.$[slot].value.time.$[entry].booked_count'
            : 'options.$[option].slots.$[slot].value.time.$[].booked_count';
        const filters: Record<string, unknown>[] = [{ 'option.id': optionId }, { 'slot.id': slotId }];

        if (time) filters.push({ 'entry.time': time });

        return this.matched({ _id: new Types.ObjectId(id) }, { $set: { [path]: 0 } }, filters, session);
    }

    /**
     * `arrayFilters` match the slot **and** `booked_count < limit`, so `modifiedCount === 0` means full.
     * Timestamps are off — `updated_at` alone would count as a modification.
     */
    async incrementTimeCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        limit: number | null,
        session?: ClientSession,
    ): Promise<boolean> {
        const timeFilter: Record<string, unknown> = { 'entry.time': time };

        if (limit !== null) timeFilter['entry.booked_count'] = { $lt: limit };

        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                { $inc: { 'options.$[option].slots.$[slot].value.time.$[entry].booked_count': 1 } },
                {
                    arrayFilters: [{ 'option.id': optionId }, { 'slot.id': slotId }, timeFilter],
                    session,
                    timestamps: false,
                },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    /** Same guard for `date` and `apply` slots, whose counter lives directly on the slot value. */
    async incrementSlotCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        limit: number | null,
        session?: ClientSession,
    ): Promise<boolean> {
        const slotFilter: Record<string, unknown> = { 'slot.id': slotId };

        if (limit !== null) slotFilter['slot.value.booked_count'] = { $lt: limit };

        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                { $inc: { 'options.$[option].slots.$[slot].value.booked_count': 1 } },
                { arrayFilters: [{ 'option.id': optionId }, slotFilter], session, timestamps: false },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    /** Guarded by `booked_count > 0` so it cannot go negative; deleting the row is what makes cancel idempotent. */
    async decrementTimeCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        session?: ClientSession,
    ): Promise<boolean> {
        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                { $inc: { 'options.$[option].slots.$[slot].value.time.$[entry].booked_count': -1 } },
                {
                    arrayFilters: [
                        { 'option.id': optionId },
                        { 'slot.id': slotId },
                        { 'entry.time': time, 'entry.booked_count': { $gt: 0 } },
                    ],
                    session,
                    timestamps: false,
                },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    async decrementSlotCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        session?: ClientSession,
    ): Promise<boolean> {
        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                { $inc: { 'options.$[option].slots.$[slot].value.booked_count': -1 } },
                {
                    arrayFilters: [
                        { 'option.id': optionId },
                        { 'slot.id': slotId, 'slot.value.booked_count': { $gt: 0 } },
                    ],
                    session,
                    timestamps: false,
                },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    findWithRecurrentOptions(): Promise<ServiceEntity[]> {
        return this.findMany(
            { 'options.recurrent_dates.0': { $exists: true }, deleted_at: null, status: { $ne: 'archived' } },
            { _id: 1 },
        );
    }

    findWithDatedSlots(): Promise<ServiceEntity[]> {
        return this.findMany({ 'options.slots.child_type': { $in: ['date_time', 'date'] } }, { _id: 1 });
    }

    findAllForDebtorReport(): Promise<ServiceEntity[]> {
        return this.projected({
            organization_id: 1,
            status: 1,
            deleted_at: 1,
            label: 1,
            'value.heading_value': 1,
            'options.service_type': 1,
            'options.enabled': 1,
            'options.recurrent_dates': 1,
            'options.slots.child_type': 1,
            'options.slots.value.date': 1,
        });
    }

    /** Slot coordinates only — the reconciliation job must not load whole service documents. */
    imageReferences(): Promise<string[]> {
        return this.model.distinct('value.image_value').exec();
    }

    findAllSlotIds(): Promise<ServiceEntity[]> {
        return this.projected({
            'options.id': 1,
            'options.slots.id': 1,
            'options.slots.child_type': 1,
            'options.slots.value.time.time': 1,
        });
    }

    private projected(projection: Record<string, 0 | 1>): Promise<ServiceEntity[]> {
        return this.model.find({}, projection).lean<ServiceEntity[]>().exec();
    }

    /** `$push`/`$pull`, never an array rewrite, and the `$pull` refuses a time entry that gained a booking. */
    async applyRecurrentPlans(
        plans: { id: string; option_id: string; plan: RecurrentSlotPlan }[],
        session?: ClientSession,
    ): Promise<number> {
        const operations: AnyBulkWriteOperation<Service>[] = [];

        for (const { id, option_id: optionId, plan } of plans) {
            const filter = { _id: new Types.ObjectId(id) };

            if (plan.add_slots.length > 0) {
                operations.push({
                    updateOne: {
                        filter,
                        update: { $push: { 'options.$[option].slots': { $each: plan.add_slots } } },
                        arrayFilters: [{ 'option.id': optionId }],
                    },
                });
            }

            for (const { slot_id: slotId, entries } of plan.add_times) {
                operations.push({
                    updateOne: {
                        filter,
                        update: {
                            $push: { 'options.$[option].slots.$[slot].value.time': { $each: entries } },
                        },
                        arrayFilters: [{ 'option.id': optionId }, { 'slot.id': slotId }],
                    },
                });
            }

            for (const { slot_id: slotId, times } of plan.remove_times) {
                operations.push({
                    updateOne: {
                        filter,
                        update: {
                            $pull: {
                                'options.$[option].slots.$[slot].value.time': {
                                    time: { $in: times },
                                    booked_count: { $lte: 0 },
                                },
                            },
                        },
                        arrayFilters: [{ 'option.id': optionId }, { 'slot.id': slotId }],
                    },
                });
            }
        }

        if (operations.length === 0) return 0;

        const result = await this.model.bulkWrite(operations, { session, ordered: false });

        return result.modifiedCount;
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
