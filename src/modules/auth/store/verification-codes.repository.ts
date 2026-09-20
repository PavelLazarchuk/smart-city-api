import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model } from 'mongoose';

import { BaseRepository, type Lean } from '../../../common/database/base.repository';
import { VerificationCode } from '../schemas/verification-code.schema';

export type VerificationCodeEntity = Lean<VerificationCode> & { code_hash: string };

@Injectable()
export class VerificationCodesRepository extends BaseRepository<VerificationCode> {
    constructor(@InjectModel(VerificationCode.name) model: Model<VerificationCode>) {
        super(model);
    }

    /** Attempt counters carry over, so asking for a fresh code does not reset the guessing budget of a number. */
    async issue(phone: string, codeHash: string, expiresAt: Date): Promise<void> {
        const superseded = await this.model
            .find({ phone, consumed_at: { $exists: false } }, { attempts: 1 })
            .lean<{ attempts: number }[]>()
            .exec();
        const attempts = superseded.reduce((total, code) => total + (code.attempts ?? 0), 0);
        await this.model.deleteMany({ phone, consumed_at: { $exists: false } }).exec();
        await this.model.create({ phone, code_hash: codeHash, attempts, expires_at: expiresAt });
    }

    findLatestActive(phone: string): Promise<VerificationCodeEntity | null> {
        return this.model
            .findOne({ phone, consumed_at: { $exists: false } })
            .sort({ created_at: -1 })
            .select('+code_hash')
            .lean<VerificationCodeEntity>()
            .exec();
    }

    /** Counts one attempt and returns the new total, so the check and the increment cannot race. */
    async registerAttempt(id: string): Promise<number | null> {
        const updated = await this.model
            .findOneAndUpdate({ _id: id }, { $inc: { attempts: 1 } }, { new: true })
            .lean<{ attempts: number }>()
            .exec();

        return updated?.attempts ?? null;
    }

    /** Marks the code used; returns false when it was consumed concurrently (single use). */
    async consume(id: string): Promise<boolean> {
        const result = await this.model
            .updateOne({ _id: id, consumed_at: { $exists: false } }, { $set: { consumed_at: new Date() } })
            .exec();

        return result.modifiedCount === 1;
    }

    deleteForPhone(phone: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ phone }, session);
    }
}
