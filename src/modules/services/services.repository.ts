import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type AnyBulkWriteOperation, type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { nextPosition, reorderSiblings } from '../../common/database/reorder';
import { type Booking, Service, type ServiceOption } from './schemas/service.schema';
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

    deleteByCategory(categoryId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ category_id: new Types.ObjectId(categoryId) }, session);
    }

    /**
     * Whole-array replacement. Only safe inside a transaction that also performed the read: a booking
     * committed in between makes the write conflict and the transaction retries.
     */
    setOptions(id: string, options: ServiceOption[], session?: ClientSession): Promise<ServiceEntity | null> {
        return this.updateById(id, { $set: { options } }, session);
    }

    async pullSlots(
        serviceId: string,
        optionId: string,
        slotIds: string[],
        session?: ClientSession,
    ): Promise<boolean> {
        if (slotIds.length === 0) return false;

        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                { $pull: { 'options.$[option].slots': { id: { $in: slotIds } } } },
                { arrayFilters: [{ 'option.id': optionId }], session },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    /**
     * Capacity-guarded append for a `date_time` time entry: `arrayFilters` match the slot **and**
     * `booked_count < limit`, so `modifiedCount === 0` means full. Automatic timestamps are off —
     * otherwise `updated_at` alone would count as a modification.
     */
    async pushTimeBooking(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        limit: number | null,
        booking: Booking,
        session?: ClientSession,
    ): Promise<boolean> {
        const timeFilter: Record<string, unknown> = { 'entry.time': time };

        if (limit !== null) timeFilter['entry.booked_count'] = { $lt: limit };

        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                {
                    $push: { 'options.$[option].slots.$[slot].value.time.$[entry].bookings': booking },
                    $inc: { 'options.$[option].slots.$[slot].value.time.$[entry].booked_count': 1 },
                },
                {
                    arrayFilters: [{ 'option.id': optionId }, { 'slot.id': slotId }, timeFilter],
                    session,
                    timestamps: false,
                },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    /** Same guard for `date` and `apply` slots, whose bookings live directly on the slot value. */
    async pushSlotBooking(
        serviceId: string,
        optionId: string,
        slotId: string,
        limit: number | null,
        booking: Booking,
        session?: ClientSession,
    ): Promise<boolean> {
        const slotFilter: Record<string, unknown> = { 'slot.id': slotId };

        if (limit !== null) slotFilter['slot.value.booked_count'] = { $lt: limit };

        const result = await this.model
            .updateOne(
                { _id: new Types.ObjectId(serviceId) },
                {
                    $push: { 'options.$[option].slots.$[slot].value.bookings': booking },
                    $inc: { 'options.$[option].slots.$[slot].value.booked_count': 1 },
                },
                { arrayFilters: [{ 'option.id': optionId }, slotFilter], session, timestamps: false },
            )
            .exec();

        return result.modifiedCount === 1;
    }

    /**
     * Mirror image of `pushTimeBooking`: `arrayFilters` require the booking to still be there, so a
     * repeated cancel cannot decrement the counter twice. A second operation clamps legacy negatives.
     */
    async pullTimeBooking(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string,
        bookingId: string,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.pullBooking(
            serviceId,
            {
                $pull: { 'options.$[option].slots.$[slot].value.time.$[entry].bookings': { id: bookingId } },
                $inc: { 'options.$[option].slots.$[slot].value.time.$[entry].booked_count': -1 },
            },
            [
                { 'option.id': optionId },
                { 'slot.id': slotId },
                { 'entry.time': time, 'entry.bookings.id': bookingId },
            ],
            {
                $set: { 'options.$[option].slots.$[slot].value.time.$[entry].booked_count': 0 },
            },
            [
                { 'option.id': optionId },
                { 'slot.id': slotId },
                { 'entry.time': time, 'entry.booked_count': { $lt: 0 } },
            ],
            session,
        );
    }

    async pullSlotBooking(
        serviceId: string,
        optionId: string,
        slotId: string,
        bookingId: string,
        session?: ClientSession,
    ): Promise<boolean> {
        return this.pullBooking(
            serviceId,
            {
                $pull: { 'options.$[option].slots.$[slot].value.bookings': { id: bookingId } },
                $inc: { 'options.$[option].slots.$[slot].value.booked_count': -1 },
            },
            [{ 'option.id': optionId }, { 'slot.id': slotId, 'slot.value.bookings.id': bookingId }],
            { $set: { 'options.$[option].slots.$[slot].value.booked_count': 0 } },
            [{ 'option.id': optionId }, { 'slot.id': slotId, 'slot.value.booked_count': { $lt: 0 } }],
            session,
        );
    }

    /**
     * Removal and clamp travel as one `bulkWrite`, so cancelling still costs a single round trip. The
     * clamp matches nothing on healthy data, hence `modifiedCount >= 1` means "the booking was there".
     */
    private async pullBooking(
        serviceId: string,
        update: Record<string, unknown>,
        arrayFilters: Record<string, unknown>[],
        clamp: Record<string, unknown>,
        clampFilters: Record<string, unknown>[],
        session?: ClientSession,
    ): Promise<boolean> {
        const filter = { _id: new Types.ObjectId(serviceId) };
        const result = await this.model.bulkWrite(
            [
                { updateOne: { filter, update, arrayFilters, timestamps: false } },
                { updateOne: { filter, update: clamp, arrayFilters: clampFilters, timestamps: false } },
            ] as AnyBulkWriteOperation<Service>[],
            { session, ordered: true },
        );

        return result.modifiedCount >= 1;
    }

    findWithBookingsOfUser(userId: string, session?: ClientSession): Promise<ServiceEntity[]> {
        const id = new Types.ObjectId(userId);

        return this.findMany(
            {
                $or: [
                    { 'options.slots.value.bookings.user_id': id },
                    { 'options.slots.value.time.bookings.user_id': id },
                ],
            },
            { _id: 1 },
            session,
        );
    }

    findWithRecurrentOptions(): Promise<ServiceEntity[]> {
        return this.findMany({ 'options.recurrent_dates.0': { $exists: true } }, { _id: 1 });
    }

    findWithDatedSlots(): Promise<ServiceEntity[]> {
        return this.findMany({ 'options.slots.child_type': { $in: ['date_time', 'date'] } }, { _id: 1 });
    }

    findAllForDebtorReport(): Promise<ServiceEntity[]> {
        return this.projected({
            organization_id: 1,
            label: 1,
            'value.heading_value': 1,
            'options.service_type': 1,
            'options.enabled': 1,
            'options.recurrent_dates': 1,
            'options.slots.child_type': 1,
            'options.slots.value.date': 1,
        });
    }

    /** Booking ids only — the report jobs must not pull whole booking lists into memory. */
    findAllBookingIds(): Promise<ServiceEntity[]> {
        return this.projected({
            'options.slots.value.bookings.id': 1,
            'options.slots.value.time.bookings.id': 1,
        });
    }

    private projected(projection: Record<string, 0 | 1>): Promise<ServiceEntity[]> {
        return this.model.find({}, projection).lean<ServiceEntity[]>().exec();
    }

    /**
     * Applies the recurrent plan of one option as `$push`/`$pull`, never an array rewrite, so a booking
     * made while the job runs survives; the `$pull` also refuses to drop a time entry that gained one.
     */
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
                                    bookings: { $size: 0 },
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
}
