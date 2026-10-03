import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type NotificationStatus } from './notification-rules';
import { Notification } from './schemas/notification.schema';

export type NotificationEntity = Lean<Notification>;

const DUPLICATE_KEY = 11000;
const NEWEST_FIRST = { created_at: -1, _id: -1 } as const;

type WriteError = { code?: number; err?: { code?: number } };

function duplicatesOnly(error: unknown): boolean {
    const { code, writeErrors } = error as { code?: number; writeErrors?: WriteError | WriteError[] };
    const failures = writeErrors === undefined ? [] : ([] as WriteError[]).concat(writeErrors);

    if (failures.length > 0) return failures.every((item) => (item.code ?? item.err?.code) === DUPLICATE_KEY);

    return code === DUPLICATE_KEY;
}

@Injectable()
export class NotificationsRepository extends BaseRepository<Notification> {
    constructor(@InjectModel(Notification.name) model: Model<Notification>) {
        super(model);
    }

    async insertNew(rows: Partial<Notification>[]): Promise<void> {
        if (rows.length === 0) return;

        try {
            await this.model.insertMany(rows, { ordered: false });
        } catch (error) {
            if (!duplicatesOnly(error)) throw error;
        }
    }

    page(filter: FilterQuery<Notification>, skip: number, limit: number): Promise<NotificationEntity[]> {
        if (limit <= 0) return Promise.resolve([]);

        return this.model
            .find(filter)
            .sort(NEWEST_FIRST)
            .skip(skip)
            .limit(limit)
            .lean<NotificationEntity[]>()
            .exec();
    }

    async countByOrganization(
        filter: FilterQuery<Notification>,
    ): Promise<{ organization_id: string; unread: number }[]> {
        const rows = await this.aggregate<{ _id: Types.ObjectId; count: number }>([
            { $match: filter },
            { $group: { _id: '$organization_id', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
        ]);

        return rows.map((row) => ({ organization_id: row._id.toHexString(), unread: row.count }));
    }

    async markRead(filter: FilterQuery<Notification>, now: Date): Promise<number> {
        const result = await this.model
            .updateMany({ ...filter, status: 'unread' }, { $set: { status: 'read', read_at: now } })
            .exec();

        return result.modifiedCount;
    }

    async trim(scope: FilterQuery<Notification>, status: NotificationStatus, keep: number): Promise<number> {
        const boundary = await this.model
            .findOne({ ...scope, status }, { _id: 1, created_at: 1 })
            .sort(NEWEST_FIRST)
            .skip(keep)
            .lean<{ _id: Types.ObjectId; created_at: Date }>()
            .exec();

        if (!boundary) return 0;

        return this.deleteMany({
            ...scope,
            status,
            $or: [
                { created_at: { $lt: boundary.created_at } },
                { created_at: boundary.created_at, _id: { $lte: boundary._id } },
            ],
        });
    }

    deleteByUser(userId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ user_id: new Types.ObjectId(userId) }, session);
    }

    deleteBySubject(userId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ audience: 'staff', subject_user_id: new Types.ObjectId(userId) }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
