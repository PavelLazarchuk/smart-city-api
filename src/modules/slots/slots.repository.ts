import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type AnyBulkWriteOperation, type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { DATED_SLOT_TYPES } from '../services/schemas/service.schema';
import { type RecurrentRangePlan, type RecurrentSlotPlan } from '../services/slot.logic';
import { Slot, type SlotBody, type TimeEntry } from './schemas/slot.schema';

export type SlotEntity = Lean<Slot>;

export interface SlotOwner {
    service_id: Types.ObjectId;
    organization_id: Types.ObjectId;
    option_id: string;
}

export interface OptionSlotStats {
    service_id: Types.ObjectId;
    option_id: string;
    total: number;
    dated: number;
    last_date: string | null;
}

@Injectable()
export class SlotsRepository extends BaseRepository<Slot> {
    constructor(@InjectModel(Slot.name) model: Model<Slot>) {
        super(model);
    }

    findByServices(serviceIds: Types.ObjectId[], session?: ClientSession): Promise<SlotEntity[]> {
        if (serviceIds.length === 0) return Promise.resolve([]);

        return this.findMany({ service_id: { $in: serviceIds } }, { _id: 1 }, session);
    }

    findSlot(
        serviceId: string,
        optionId: string,
        slotId: string,
        session?: ClientSession,
    ): Promise<SlotEntity | null> {
        return this.findOne(this.key(serviceId, optionId, slotId), session);
    }

    async insert(owner: SlotOwner, slots: SlotBody[], session?: ClientSession): Promise<void> {
        if (slots.length === 0) return;

        await this.model.insertMany(
            slots.map((slot) => ({ ...owner, ...slot })),
            { session, ordered: true },
        );
    }

    async setFields(
        serviceId: string,
        optionId: string,
        slotId: string,
        fields: Record<string, unknown>,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(this.key(serviceId, optionId, slotId), { $set: fields }, undefined, session);
    }

    deleteSlots(
        serviceId: string,
        optionId: string,
        slotIds: string[],
        session?: ClientSession,
    ): Promise<number> {
        if (slotIds.length === 0) return Promise.resolve(0);

        return this.deleteMany(
            { service_id: new Types.ObjectId(serviceId), option_id: optionId, id: { $in: slotIds } },
            session,
        );
    }

    deleteByOption(serviceId: string, optionId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ service_id: new Types.ObjectId(serviceId), option_id: optionId }, session);
    }

    deleteByService(serviceId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ service_id: new Types.ObjectId(serviceId) }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }

    async pushTimes(
        serviceId: string,
        optionId: string,
        slotId: string,
        entries: TimeEntry[],
        session?: ClientSession,
    ): Promise<boolean> {
        if (entries.length === 0) return false;

        return this.matched(
            this.key(serviceId, optionId, slotId),
            { $push: { 'value.time': { $each: entries } } },
            undefined,
            session,
        );
    }

    async pullTimes(
        serviceId: string,
        optionId: string,
        slotId: string,
        times: string[],
        session?: ClientSession,
    ): Promise<boolean> {
        if (times.length === 0) return false;

        return this.matched(
            this.key(serviceId, optionId, slotId),
            { $pull: { 'value.time': { time: { $in: times } } } },
            undefined,
            session,
        );
    }

    setTimeLimit(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        limit: number | null,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            this.key(serviceId, optionId, slotId),
            { $set: { 'value.time.$[entry].limit': limit } },
            [{ 'entry.time': time }],
            session,
        );
    }

    setTimeEnd(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        to: string,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            this.key(serviceId, optionId, slotId),
            { $set: { 'value.time.$[entry].to': to } },
            [{ 'entry.time': time }],
            session,
        );
    }

    async renameTimes(
        serviceId: string,
        optionId: string,
        slotId: string,
        moves: [string, string][],
        session?: ClientSession,
    ): Promise<number> {
        if (moves.length === 0) return 0;

        const result = await this.model.bulkWrite(
            moves.map(([from, to]) => ({
                updateOne: {
                    filter: this.key(serviceId, optionId, slotId),
                    update: { $set: { 'value.time.$[entry].time': to } },
                    arrayFilters: [{ 'entry.time': from }],
                },
            })),
            { session, ordered: true },
        );

        return result.modifiedCount;
    }

    clearSlotCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.matched(
            this.key(serviceId, optionId, slotId),
            { $set: { 'value.booked_count': 0 } },
            undefined,
            session,
        );
    }

    clearTimeCounts(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string | undefined,
        session?: ClientSession,
    ): Promise<boolean> {
        return time
            ? this.matched(
                  this.key(serviceId, optionId, slotId),
                  { $set: { 'value.time.$[entry].booked_count': 0 } },
                  [{ 'entry.time': time }],
                  session,
              )
            : this.matched(
                  this.key(serviceId, optionId, slotId),
                  { $set: { 'value.time.$[].booked_count': 0 } },
                  undefined,
                  session,
              );
    }

    async incrementTimeCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        limit: number | null,
        session?: ClientSession,
    ): Promise<boolean> {
        const entry: Record<string, unknown> = { 'entry.time': time };

        if (limit !== null) entry['entry.booked_count'] = { $lt: limit };

        const result = await this.model
            .updateOne(
                this.key(serviceId, optionId, slotId),
                { $inc: { 'value.time.$[entry].booked_count': 1 } },
                { arrayFilters: [entry], session, timestamps: false },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    async incrementSlotCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        limit: number | null,
        session?: ClientSession,
    ): Promise<boolean> {
        const filter: FilterQuery<Slot> = this.key(serviceId, optionId, slotId);

        if (limit !== null) filter['value.booked_count'] = { $lt: limit };

        const result = await this.model
            .updateOne(filter, { $inc: { 'value.booked_count': 1 } }, { session, timestamps: false })
            .exec();

        return result.modifiedCount === 1;
    }

    async decrementTimeCount(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        session?: ClientSession,
    ): Promise<boolean> {
        const result = await this.model
            .updateOne(
                this.key(serviceId, optionId, slotId),
                { $inc: { 'value.time.$[entry].booked_count': -1 } },
                {
                    arrayFilters: [{ 'entry.time': time, 'entry.booked_count': { $gt: 0 } }],
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
                { ...this.key(serviceId, optionId, slotId), 'value.booked_count': { $gt: 0 } },
                { $inc: { 'value.booked_count': -1 } },
                { session, timestamps: false },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    findDatedBefore(date: string): Promise<SlotEntity[]> {
        return this.model
            .find(
                { child_type: { $in: DATED_SLOT_TYPES }, 'value.date': { $type: 'string', $lt: date } },
                { service_id: 1, organization_id: 1, option_id: 1, child_type: 1, 'value.date': 1 },
            )
            .lean<SlotEntity[]>()
            .exec();
    }

    findRecurringByServices(serviceIds: Types.ObjectId[]): Promise<SlotEntity[]> {
        if (serviceIds.length === 0) return Promise.resolve([]);

        return this.model
            .find({ service_id: { $in: serviceIds }, child_type: { $in: ['date_time', 'time_range'] } })
            .sort({ _id: 1 })
            .lean<SlotEntity[]>()
            .exec();
    }

    optionStats(): Promise<OptionSlotStats[]> {
        return this.aggregate<OptionSlotStats>([
            {
                $group: {
                    _id: { service_id: '$service_id', option_id: '$option_id' },
                    total: { $sum: 1 },
                    dated: {
                        $sum: { $cond: [{ $in: ['$child_type', DATED_SLOT_TYPES] }, 1, 0] },
                    },
                    last_date: {
                        $max: {
                            $cond: [{ $in: ['$child_type', DATED_SLOT_TYPES] }, '$value.date', null],
                        },
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    service_id: '$_id.service_id',
                    option_id: '$_id.option_id',
                    total: 1,
                    dated: 1,
                    last_date: 1,
                },
            },
        ]);
    }

    iterateKeys(): AsyncIterable<
        Pick<SlotEntity, 'service_id' | 'option_id' | 'id' | 'child_type' | 'value'>
    > {
        return this.model
            .find({}, { service_id: 1, option_id: 1, id: 1, child_type: 1, 'value.time.time': 1 })
            .lean<Pick<SlotEntity, 'service_id' | 'option_id' | 'id' | 'child_type' | 'value'>[]>()
            .cursor();
    }

    async applyRecurrentPlans(
        plans: (SlotOwner & { plan: RecurrentSlotPlan; ranges?: RecurrentRangePlan })[],
        session?: ClientSession,
    ): Promise<number> {
        const operations: AnyBulkWriteOperation<Slot>[] = [];

        for (const { plan, ranges, ...owner } of plans) {
            const serviceId = owner.service_id.toHexString();

            for (const slot of ranges?.add_slots ?? [])
                operations.push({ insertOne: { document: { ...owner, ...slot } } });

            for (const { slot_id: slotId, range } of ranges?.update_ranges ?? []) {
                operations.push({
                    updateOne: {
                        filter: {
                            ...this.key(serviceId, owner.option_id, slotId),
                            'value.booked_count': { $lte: 0 },
                        },
                        update: {
                            $set: {
                                'value.from': range.from,
                                'value.to': range.to,
                                'value.step_minutes': range.step_minutes,
                                'value.min_minutes': range.min_minutes,
                                'value.max_minutes': range.max_minutes,
                            },
                        },
                    },
                });
            }

            if (ranges?.remove_slots.length)
                operations.push({
                    deleteMany: {
                        filter: {
                            service_id: owner.service_id,
                            option_id: owner.option_id,
                            id: { $in: ranges.remove_slots },
                            'value.booked_count': { $lte: 0 },
                        },
                    },
                });

            for (const slot of plan.add_slots)
                operations.push({ insertOne: { document: { ...owner, ...slot } } });

            for (const { slot_id: slotId, entries } of plan.add_times) {
                operations.push({
                    updateOne: {
                        filter: this.key(serviceId, owner.option_id, slotId),
                        update: { $push: { 'value.time': { $each: entries } } },
                    },
                });
            }

            for (const { slot_id: slotId, times } of plan.remove_times) {
                operations.push({
                    updateOne: {
                        filter: this.key(serviceId, owner.option_id, slotId),
                        update: {
                            $pull: { 'value.time': { time: { $in: times }, booked_count: { $lte: 0 } } },
                        },
                    },
                });
            }
        }

        if (operations.length === 0) return 0;

        const result = await this.model.bulkWrite(operations, { session, ordered: false });

        return result.insertedCount + result.modifiedCount + result.deletedCount;
    }

    private key(serviceId: string, optionId: string, slotId: string): FilterQuery<Slot> {
        return { service_id: new Types.ObjectId(serviceId), option_id: optionId, id: slotId };
    }

    private async matched(
        filter: FilterQuery<Slot>,
        update: Record<string, unknown>,
        arrayFilters: Record<string, unknown>[] | undefined,
        session?: ClientSession,
    ): Promise<boolean> {
        const result = await this.model.updateOne(filter, update, { arrayFilters, session }).exec();

        return result.matchedCount === 1;
    }
}
