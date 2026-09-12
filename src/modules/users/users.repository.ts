import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { User } from './schemas/user.schema';

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

    /**
     * Counts one failure and returns the new total, or `null` when the account is gone. A failure
     * whose predecessor is older than `windowStart` starts the count at one again — the decision is
     * part of the update itself, so two concurrent attempts cannot both read the stale counter.
     */
    async incrementFailedLogins(
        id: string,
        windowStart: Date,
        now: Date,
        session?: ClientSession,
    ): Promise<number | null> {
        const updated = await this.model
            .findByIdAndUpdate(
                id,
                [
                    {
                        $set: {
                            failed_login_attempts: {
                                $cond: [
                                    {
                                        $gte: [
                                            { $ifNull: ['$last_failed_login_at', new Date(0)] },
                                            windowStart,
                                        ],
                                    },
                                    { $add: [{ $ifNull: ['$failed_login_attempts', 0] }, 1] },
                                    1,
                                ],
                            },
                            last_failed_login_at: now,
                        },
                    },
                ],
                { new: true },
            )
            .session(session ?? null)
            .lean<{ failed_login_attempts: number }>()
            .exec();

        return updated?.failed_login_attempts ?? null;
    }

    async lockUntil(id: string, until: Date, session?: ClientSession): Promise<void> {
        await this.model
            .updateOne({ _id: new Types.ObjectId(id) }, { $set: { locked_until: until } })
            .session(session ?? null)
            .exec();
    }

    async clearFailedLogins(id: string, session?: ClientSession): Promise<void> {
        await this.model
            .updateOne(
                { _id: new Types.ObjectId(id) },
                { $set: { failed_login_attempts: 0 }, $unset: { locked_until: 1, last_failed_login_at: 1 } },
            )
            .session(session ?? null)
            .exec();
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
