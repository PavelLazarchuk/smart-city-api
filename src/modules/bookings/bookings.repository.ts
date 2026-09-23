import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { Booking, type BookingStatus } from './schemas/booking.schema';

export type BookingEntity = Lean<Booking>;

export interface BookingStatusCounts {
    total: number;
    by_status: Record<BookingStatus, number>;
}

@Injectable()
export class BookingsRepository extends BaseRepository<Booking> {
    constructor(@InjectModel(Booking.name) model: Model<Booking>) {
        super(model);
    }

    findByPublicId(id: string, session?: ClientSession): Promise<BookingEntity | null> {
        return this.findOne({ id }, session);
    }

    list(
        filter: FilterQuery<Booking>,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<BookingEntity>> {
        return this.paginate(filter, pagination);
    }

    findByUser(userId: string, session?: ClientSession, activeOnly = true): Promise<BookingEntity[]> {
        const filter: FilterQuery<Booking> = { user_id: new Types.ObjectId(userId) };

        if (activeOnly) filter['active'] = true;

        return this.findMany(filter, { created_at: -1 }, session);
    }

    findActiveByServices(serviceIds: string[], session?: ClientSession): Promise<BookingEntity[]> {
        if (serviceIds.length === 0) return Promise.resolve([]);

        return this.findMany(
            { service_id: { $in: serviceIds.map((id) => new Types.ObjectId(id)) }, active: true },
            { created_at: 1 },
            session,
        );
    }

    findBySlots(
        serviceId: string,
        optionId: string,
        slotIds: string[],
        session?: ClientSession,
    ): Promise<BookingEntity[]> {
        if (slotIds.length === 0) return Promise.resolve([]);

        return this.findMany(
            { service_id: new Types.ObjectId(serviceId), option_id: optionId, slot_id: { $in: slotIds } },
            { created_at: 1 },
            session,
        );
    }

    findActiveBySlot(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string | undefined,
        limit: number,
        session?: ClientSession,
    ): Promise<BookingEntity[]> {
        const filter: FilterQuery<Booking> = {
            service_id: new Types.ObjectId(serviceId),
            option_id: optionId,
            slot_id: slotId,
            active: true,
        };

        if (time !== undefined) filter['slot_time'] = time;

        return this.model
            .find(filter)
            .sort({ created_at: 1, _id: 1 })
            .limit(limit)
            .session(session ?? null)
            .lean<BookingEntity[]>()
            .exec();
    }

    async cancelMany(ids: string[], by: Types.ObjectId, now: Date, session?: ClientSession): Promise<number> {
        if (ids.length === 0) return 0;

        const result = await this.model
            .updateMany(
                { id: { $in: ids }, active: true },
                {
                    $set: {
                        status: 'cancelled',
                        active: false,
                        finished_at: now,
                        status_changed_by: by,
                    },
                },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    async moveMany(
        moves: { id: string; slot_date: string; slot_time: string | null; starts_at: Date | null }[],
        session?: ClientSession,
    ): Promise<number> {
        if (moves.length === 0) return 0;

        const result = await this.model.bulkWrite(
            moves.map(({ id, slot_date: slotDate, slot_time: slotTime, starts_at: startsAt }) => ({
                updateOne: {
                    filter: { id, active: true },
                    update: {
                        $set: {
                            slot_date: slotDate,
                            slot_time: slotTime,
                            starts_at: startsAt,
                            reminder_sent_at: null,
                        },
                    },
                },
            })),
            { session, ordered: true },
        );

        return result.modifiedCount;
    }

    countActiveBySlot(
        serviceId: string,
        optionId: string,
        slotId: string,
        session?: ClientSession,
    ): Promise<number> {
        return this.count(
            { service_id: new Types.ObjectId(serviceId), option_id: optionId, slot_id: slotId, active: true },
            session,
        );
    }

    countActiveByTimes(
        serviceId: string,
        optionId: string,
        slotId: string,
        times: string[],
        session?: ClientSession,
    ): Promise<number> {
        if (times.length === 0) return Promise.resolve(0);

        return this.count(
            {
                service_id: new Types.ObjectId(serviceId),
                option_id: optionId,
                slot_id: slotId,
                slot_time: { $in: times },
                active: true,
            },
            session,
        );
    }

    countActiveByOption(serviceId: string, optionId: string, session?: ClientSession): Promise<number> {
        return this.count(
            { service_id: new Types.ObjectId(serviceId), option_id: optionId, active: true },
            session,
        );
    }

    countActiveByUserAndService(userId: string, serviceId: string, session?: ClientSession): Promise<number> {
        return this.count(
            { user_id: new Types.ObjectId(userId), service_id: new Types.ObjectId(serviceId), active: true },
            session,
        );
    }

    async transition(
        id: string,
        from: BookingStatus[],
        to: BookingStatus,
        by: Types.ObjectId | null,
        now: Date,
        session?: ClientSession,
    ): Promise<BookingEntity | null> {
        const active = to === 'pending' || to === 'confirmed';
        const set: Record<string, unknown> = { status: to, active, status_changed_by: by };

        if (to === 'confirmed') set['confirmed_at'] = now;

        if (!active) set['finished_at'] = now;

        return this.model
            .findOneAndUpdate({ id, status: { $in: from } }, { $set: set }, { new: true, session })
            .lean<BookingEntity>()
            .exec();
    }

    async move(
        id: string,
        target: {
            option_id: string;
            slot_id: string;
            child_type: string;
            slot_date: string | null;
            slot_time: string | null;
            starts_at: Date | null;
        },
        session?: ClientSession,
    ): Promise<BookingEntity | null> {
        return this.model
            .findOneAndUpdate({ id, active: true }, { $set: target }, { new: true, session })
            .lean<BookingEntity>()
            .exec();
    }

    async deleteByPublicId(id: string, session?: ClientSession): Promise<boolean> {
        return (await this.deleteMany({ id }, session)) > 0;
    }

    deleteByUser(userId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ user_id: new Types.ObjectId(userId) }, session);
    }

    async anonymizeFinishedByUser(userId: string, session?: ClientSession): Promise<number> {
        const result = await this.model
            .updateMany(
                { user_id: new Types.ObjectId(userId), active: false },
                { $set: { person: '', phone: '', info: '', fields: {}, documents: [] } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    deleteByService(serviceId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ service_id: new Types.ObjectId(serviceId) }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }

    deleteBySlots(
        serviceId: string,
        optionId: string,
        slotIds: string[],
        session?: ClientSession,
        activeOnly = false,
    ): Promise<number> {
        if (slotIds.length === 0) return Promise.resolve(0);

        const filter: FilterQuery<Booking> = {
            service_id: new Types.ObjectId(serviceId),
            option_id: optionId,
            slot_id: { $in: slotIds },
        };

        if (activeOnly) filter['active'] = true;

        return this.deleteMany(filter, session);
    }

    deleteByIds(ids: string[], session?: ClientSession): Promise<number> {
        if (ids.length === 0) return Promise.resolve(0);

        return this.deleteMany({ id: { $in: ids } }, session);
    }

    iterateActive(): AsyncIterable<BookingEntity> {
        return this.model
            .find({ active: true }, { id: 1, service_id: 1, option_id: 1, slot_id: 1, slot_time: 1 })
            .lean<BookingEntity>()
            .cursor({ batchSize: 200 });
    }

    findDueReminders(from: Date, to: Date, limit: number): Promise<BookingEntity[]> {
        return this.model
            .find({ active: true, starts_at: { $gt: from, $lte: to }, reminder_sent_at: null })
            .sort({ _id: 1 })
            .limit(limit)
            .lean<BookingEntity[]>()
            .exec();
    }

    async markReminded(ids: string[], at: Date): Promise<number> {
        if (ids.length === 0) return 0;

        const result = await this.model
            .updateMany({ id: { $in: ids } }, { $set: { reminder_sent_at: at } })
            .exec();

        return result.modifiedCount;
    }

    async countByStatus(filter: FilterQuery<Booking>): Promise<BookingStatusCounts> {
        const rows = await this.aggregate<{ _id: BookingStatus; count: number }>([
            { $match: filter },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);
        const byStatus: Record<BookingStatus, number> = {
            pending: 0,
            confirmed: 0,
            completed: 0,
            no_show: 0,
            cancelled: 0,
        };

        for (const row of rows) byStatus[row._id] = row.count;

        return { total: rows.reduce((sum, row) => sum + row.count, 0), by_status: byStatus };
    }
}
