import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../../common/database/base.repository';
import { Session } from '../schemas/session.schema';

export type SessionEntity = Lean<Session>;

@Injectable()
export class SessionsRepository extends BaseRepository<Session> {
    constructor(@InjectModel(Session.name) model: Model<Session>) {
        super(model);
    }

    async createSession(
        data: {
            _id: Types.ObjectId;
            user_id: Types.ObjectId;
            family_id: Types.ObjectId;
            refresh_token_hash: string;
            expires_at: Date;
            user_agent?: string;
            ip?: string;
        },
        session?: ClientSession,
    ): Promise<SessionEntity> {
        return this.create(data, session);
    }

    findWithHash(
        id: string,
        session?: ClientSession,
    ): Promise<(SessionEntity & { refresh_token_hash: string }) | null> {
        if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);

        return this.model
            .findById(id)
            .select('+refresh_token_hash')
            .session(session ?? null)
            .lean<SessionEntity & { refresh_token_hash: string }>()
            .exec();
    }

    async findActive(id: string): Promise<SessionEntity | null> {
        if (!Types.ObjectId.isValid(id)) return null;

        return this.model
            .findOne({
                _id: id,
                revoked_at: { $exists: false },
                replaced_by: { $exists: false },
                expires_at: { $gt: new Date() },
            })
            .lean<SessionEntity>()
            .exec();
    }

    findActiveForUser(userId: string): Promise<SessionEntity[]> {
        return this.findMany(
            {
                user_id: new Types.ObjectId(userId),
                revoked_at: { $exists: false },
                replaced_by: { $exists: false },
                expires_at: { $gt: new Date() },
            },
            { created_at: -1 },
        );
    }

    async revokeOwned(userId: string, sid: string): Promise<boolean> {
        if (!Types.ObjectId.isValid(sid)) return false;

        const result = await this.model
            .updateOne(
                {
                    _id: new Types.ObjectId(sid),
                    user_id: new Types.ObjectId(userId),
                    revoked_at: { $exists: false },
                },
                { $set: { revoked_at: new Date() } },
            )
            .exec();

        return result.matchedCount === 1;
    }

    async markReplaced(
        id: Types.ObjectId,
        replacedBy: Types.ObjectId,
        session?: ClientSession,
    ): Promise<boolean> {
        const result = await this.model
            .updateOne(
                { _id: id, replaced_by: { $exists: false }, revoked_at: { $exists: false } },
                { $set: { replaced_by: replacedBy } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount === 1;
    }

    async revoke(id: string, session?: ClientSession): Promise<void> {
        await this.model
            .updateOne({ _id: id, revoked_at: { $exists: false } }, { $set: { revoked_at: new Date() } })
            .session(session ?? null)
            .exec();
    }

    async revokeFamily(familyId: Types.ObjectId, session?: ClientSession): Promise<number> {
        const result = await this.model
            .updateMany(
                { family_id: familyId, revoked_at: { $exists: false } },
                { $set: { revoked_at: new Date() } },
            )
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }

    /** `exceptSid` keeps the caller's own session alive, e.g. when they change their password. */
    async revokeAllForUser(userId: string, session?: ClientSession, exceptSid?: string): Promise<number> {
        const filter: Record<string, unknown> = {
            user_id: new Types.ObjectId(userId),
            revoked_at: { $exists: false },
        };

        if (exceptSid && Types.ObjectId.isValid(exceptSid))
            filter['_id'] = { $ne: new Types.ObjectId(exceptSid) };

        const result = await this.model
            .updateMany(filter, { $set: { revoked_at: new Date() } })
            .session(session ?? null)
            .exec();

        return result.modifiedCount;
    }
}
