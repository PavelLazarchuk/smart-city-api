import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ThrottlerStorage } from '@nestjs/throttler';
import { Model, type PipelineStage } from 'mongoose';

import { RateLimit } from './schemas/rate-limit.schema';

interface ThrottlerStorageRecord {
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
}

/** `ThrottlerStorage` backed by the `rate_limits` collection so limits hold across replicas. */
@Injectable()
export class MongoThrottlerStorage implements ThrottlerStorage {
    constructor(@InjectModel(RateLimit.name) private readonly model: Model<RateLimit>) {}

    /**
     * One atomic pipeline update decides whether the window is alive, counts the hit and sets the block.
     * In two steps, simultaneous requests each started a fresh window — the limit collapsed under bursts.
     */
    async increment(
        key: string,
        ttl: number,
        limit: number,
        blockDuration: number,
        _throttlerName: string,
    ): Promise<ThrottlerStorageRecord> {
        const now = new Date();
        const nowMs = now.getTime();
        const alive = { $gt: ['$expires_at', now] };
        const pipeline: Exclude<PipelineStage, PipelineStage.Merge | PipelineStage.Out>[] = [
            {
                $set: {
                    total_hits: { $cond: [alive, { $add: [{ $ifNull: ['$total_hits', 0] }, 1] }, 1] },
                    expires_at: { $cond: [alive, '$expires_at', new Date(nowMs + ttl)] },
                    blocked_until: { $cond: [alive, '$blocked_until', '$$REMOVE'] },
                },
            },
            {
                $set: {
                    blocked_until: {
                        $cond: [
                            {
                                $and: [
                                    { $gt: ['$total_hits', limit] },
                                    { $not: [{ $gt: [{ $ifNull: ['$blocked_until', new Date(0)] }, now] }] },
                                ],
                            },
                            new Date(nowMs + Math.max(blockDuration, ttl)),
                            '$blocked_until',
                        ],
                    },
                },
            },
        ];
        const record = await this.model
            .findOneAndUpdate({ _id: key }, pipeline, { upsert: true, new: true })
            .lean<RateLimit>()
            .exec();

        if (!record) throw new Error('rate limit record missing');

        const blockedUntil = record.blocked_until?.getTime() ?? 0;
        const isBlocked = blockedUntil > nowMs;

        return {
            totalHits: record.total_hits,
            timeToExpire: Math.max(0, Math.ceil((record.expires_at.getTime() - nowMs) / 1000)),
            isBlocked,
            timeToBlockExpire: isBlocked ? Math.ceil((blockedUntil - nowMs) / 1000) : 0,
        };
    }
}
