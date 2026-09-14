import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { AppConfig } from '../config/app-config';
import { ApiError } from '../http/api-error';
import { IdempotencyKey } from './schemas/idempotency-key.schema';

const DUPLICATE_KEY = 11000;

export interface IdempotentOutcome<T> {
    result: T;
    replayed: boolean;
}

@Injectable()
export class IdempotencyService {
    constructor(
        @InjectModel(IdempotencyKey.name) private readonly model: Model<IdempotencyKey>,
        private readonly config: AppConfig,
    ) {}

    async run<T extends Record<string, unknown>>(
        scope: string,
        key: string,
        userId: string,
        request: unknown,
        handler: () => Promise<T>,
    ): Promise<IdempotentOutcome<T>> {
        const requestHash = createHash('sha256')
            .update(JSON.stringify(request ?? null))
            .digest('hex');
        const filter = { scope, key, user_id: new Types.ObjectId(userId) };

        try {
            const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
            await this.model.create([{ ...filter, request_hash: requestHash, expires_at: expiresAt }], {});
        } catch (error) {
            if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;

            return { result: await this.replay<T>(filter, requestHash), replayed: true };
        }

        let result: T;

        try {
            result = await handler();
        } catch (error) {
            await this.model.deleteOne(filter).exec();
            throw error;
        }

        await this.model.updateOne(filter, { $set: { status: 'completed', response: result } }).exec();

        return { result, replayed: false };
    }

    get ttlSeconds(): number {
        return this.config.idempotency.ttlSeconds;
    }

    private async replay<T>(filter: Record<string, unknown>, requestHash: string): Promise<T> {
        const existing = await this.model.findOne(filter).lean<IdempotencyKey>().exec();

        if (!existing) throw ApiError.conflict('IDEMPOTENCY_IN_PROGRESS');

        if (existing.request_hash !== requestHash) throw ApiError.unprocessable('IDEMPOTENCY_KEY_REUSED');

        if (existing.status !== 'completed' || !existing.response)
            throw ApiError.conflict('IDEMPOTENCY_IN_PROGRESS');

        return existing.response as T;
    }
}
