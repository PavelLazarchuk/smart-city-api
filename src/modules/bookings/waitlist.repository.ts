import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { WaitlistEntry } from './schemas/waitlist.schema';

export type WaitlistEntryEntity = Lean<WaitlistEntry>;

@Injectable()
export class WaitlistRepository extends BaseRepository<WaitlistEntry> {
    constructor(@InjectModel(WaitlistEntry.name) model: Model<WaitlistEntry>) {
        super(model);
    }

    findByPublicId(id: string, session?: ClientSession): Promise<WaitlistEntryEntity | null> {
        return this.findOne({ id }, session);
    }

    listByUser(
        userId: string,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<WaitlistEntryEntity>> {
        return this.paginate({ user_id: new Types.ObjectId(userId) }, pagination);
    }

    list(
        filter: FilterQuery<WaitlistEntry>,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<WaitlistEntryEntity>> {
        return this.paginate(filter, pagination);
    }

    claimNextWaiting(
        serviceId: Types.ObjectId,
        optionId: string,
        slotId: string,
        slotTime: string | null,
        now: Date,
        session?: ClientSession,
    ): Promise<WaitlistEntryEntity | null> {
        return this.model
            .findOneAndUpdate(
                {
                    service_id: serviceId,
                    option_id: optionId,
                    slot_id: slotId,
                    slot_time: slotTime,
                    status: 'waiting',
                },
                { $set: { status: 'notified', notified_at: now } },
                { sort: { created_at: 1, _id: 1 }, new: true, session },
            )
            .lean<WaitlistEntryEntity>()
            .exec();
    }

    async deleteByPublicId(id: string, session?: ClientSession): Promise<boolean> {
        return (await this.deleteMany({ id }, session)) > 0;
    }

    deleteForUserSlot(
        userId: Types.ObjectId,
        serviceId: Types.ObjectId,
        optionId: string,
        slotId: string,
        slotTime: string | null,
        session?: ClientSession,
    ): Promise<number> {
        return this.deleteMany(
            {
                user_id: userId,
                service_id: serviceId,
                option_id: optionId,
                slot_id: slotId,
                slot_time: slotTime,
            },
            session,
        );
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
}
