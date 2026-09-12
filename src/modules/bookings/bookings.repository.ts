import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { Booking } from './schemas/booking.schema';

export type BookingEntity = Lean<Booking>;

@Injectable()
export class BookingsRepository extends BaseRepository<Booking> {
    constructor(@InjectModel(Booking.name) model: Model<Booking>) {
        super(model);
    }

    findByPublicId(id: string, session?: ClientSession): Promise<BookingEntity | null> {
        return this.findOne({ id }, session);
    }

    findByUser(userId: string, session?: ClientSession): Promise<BookingEntity[]> {
        return this.findMany({ user_id: new Types.ObjectId(userId) }, { created_at: -1 }, session);
    }

    findByServices(serviceIds: string[], session?: ClientSession): Promise<BookingEntity[]> {
        if (serviceIds.length === 0) return Promise.resolve([]);

        return this.findMany(
            { service_id: { $in: serviceIds.map((id) => new Types.ObjectId(id)) } },
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

    countBySlot(
        serviceId: string,
        optionId: string,
        slotId: string,
        session?: ClientSession,
    ): Promise<number> {
        return this.count(
            { service_id: new Types.ObjectId(serviceId), option_id: optionId, slot_id: slotId },
            session,
        );
    }

    countByTimes(
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
            },
            session,
        );
    }

    countByOption(serviceId: string, optionId: string, session?: ClientSession): Promise<number> {
        return this.count({ service_id: new Types.ObjectId(serviceId), option_id: optionId }, session);
    }

    async deleteByPublicId(id: string, session?: ClientSession): Promise<boolean> {
        return (await this.deleteMany({ id }, session)) > 0;
    }

    deleteByUser(userId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ user_id: new Types.ObjectId(userId) }, session);
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
    ): Promise<number> {
        if (slotIds.length === 0) return Promise.resolve(0);

        return this.deleteMany(
            { service_id: new Types.ObjectId(serviceId), option_id: optionId, slot_id: { $in: slotIds } },
            session,
        );
    }

    deleteByIds(ids: string[], session?: ClientSession): Promise<number> {
        if (ids.length === 0) return Promise.resolve(0);

        return this.deleteMany({ id: { $in: ids } }, session);
    }

    /** Streams every booking, ids and slot coordinates only, for the nightly consistency job. */
    iterateAll(): AsyncIterable<BookingEntity> {
        return this.model
            .find({}, { id: 1, service_id: 1, option_id: 1, slot_id: 1, slot_time: 1 })
            .lean<BookingEntity>()
            .cursor({ batchSize: 200 });
    }
}
