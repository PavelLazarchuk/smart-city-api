import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { type BookingRef, User } from './schemas/user.schema';

export type UserEntity = Lean<User>;

@Injectable()
export class UsersRepository extends BaseRepository<User> {
    constructor(@InjectModel(User.name) model: Model<User>) {
        super(model);
    }

    findByLoginWithPassword(
        login: string,
        session?: ClientSession,
    ): Promise<(UserEntity & { password_hash?: string }) | null> {
        return this.model
            .findOne({ login })
            .select('+password_hash')
            .session(session ?? null)
            .lean<UserEntity & { password_hash?: string }>()
            .exec();
    }

    findByPhoneWithPassword(
        phone: string,
        session?: ClientSession,
    ): Promise<(UserEntity & { password_hash?: string }) | null> {
        return this.model
            .findOne({ phone })
            .select('+password_hash')
            .session(session ?? null)
            .lean<UserEntity & { password_hash?: string }>()
            .exec();
    }

    findByIdWithPassword(
        id: string,
        session?: ClientSession,
    ): Promise<(UserEntity & { password_hash?: string }) | null> {
        return this.model
            .findById(id)
            .select('+password_hash')
            .session(session ?? null)
            .lean<UserEntity & { password_hash?: string }>()
            .exec();
    }

    findByPhone(phone: string, session?: ClientSession): Promise<UserEntity | null> {
        return this.findOne({ phone }, session);
    }

    findByLogin(login: string, session?: ClientSession): Promise<UserEntity | null> {
        return this.findOne({ login }, session);
    }

    countOtherSuperAdmins(exceptId: string): Promise<number> {
        return this.count({ role: 'super-admin', _id: { $ne: new Types.ObjectId(exceptId) } });
    }

    list(filter: FilterQuery<User>, pagination: ResolvedPagination): Promise<PaginatedResult<UserEntity>> {
        return this.paginate(filter, pagination);
    }

    setOrganizationIds(
        userId: string,
        organizationIds: string[],
        session?: ClientSession,
    ): Promise<UserEntity | null> {
        return this.updateById(
            userId,
            { $set: { organization_ids: organizationIds.map((id) => new Types.ObjectId(id)) } },
            session,
        );
    }

    async detachOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        const result = await this.model
            .updateMany(
                { organization_ids: new Types.ObjectId(organizationId) },
                { $pull: { organization_ids: new Types.ObjectId(organizationId) } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    async addBooking(userId: string, booking: BookingRef, session?: ClientSession): Promise<void> {
        await this.model
            .updateOne({ _id: userId }, { $push: { bookings: booking } })
            .session(session ?? null)
            .exec();
    }

    async removeBooking(userId: string, bookingId: string, session?: ClientSession): Promise<void> {
        await this.model
            .updateOne({ _id: userId }, { $pull: { bookings: { id: bookingId } } })
            .session(session ?? null)
            .exec();
    }

    async removeBookingsByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        const result = await this.model
            .updateMany(
                { 'bookings.organization_id': new Types.ObjectId(organizationId) },
                { $pull: { bookings: { organization_id: new Types.ObjectId(organizationId) } } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    async removeBookingsByService(serviceId: string, session?: ClientSession): Promise<number> {
        const result = await this.model
            .updateMany(
                { 'bookings.service_id': new Types.ObjectId(serviceId) },
                { $pull: { bookings: { service_id: new Types.ObjectId(serviceId) } } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    async removeBookingsByIds(bookingIds: string[], session?: ClientSession): Promise<number> {
        if (bookingIds.length === 0) return 0;

        const result = await this.model
            .updateMany(
                { 'bookings.id': { $in: bookingIds } },
                { $pull: { bookings: { id: { $in: bookingIds } } } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    /** Streams accounts that hold bookings, ids only: the nightly job must not load whole user documents. */
    iterateWithBookings(): AsyncIterable<{ _id: Types.ObjectId; bookings: { id: string }[] }> {
        return this.model
            .find({ 'bookings.0': { $exists: true } }, { 'bookings.id': 1 })
            .lean<{ _id: Types.ObjectId; bookings: { id: string }[] }>()
            .cursor({ batchSize: 200 });
    }

    async updateFields(
        id: string,
        set: Record<string, unknown>,
        unset: string[] = [],
        session?: ClientSession,
    ): Promise<UserEntity | null> {
        const update: Record<string, unknown> = {};

        if (Object.keys(set).length > 0) update['$set'] = set;

        if (unset.length > 0) update['$unset'] = Object.fromEntries(unset.map((key) => [key, 1]));

        if (Object.keys(update).length === 0) return this.findById(id, session);

        return this.updateById(id, update, session);
    }
}
