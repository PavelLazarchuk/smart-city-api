import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../database/schema-options';

export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

@Schema(baseSchemaOptions('idempotency_keys'))
export class IdempotencyKey {
    @Prop({ type: String, required: true })
    scope!: string;

    @Prop({ type: String, required: true })
    key!: string;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    user_id!: Types.ObjectId;

    @Prop({ type: String, required: true })
    request_hash!: string;

    @Prop({ type: String, enum: IDEMPOTENCY_STATUSES, default: 'in_progress' })
    status!: IdempotencyStatus;

    @Prop({ type: SchemaTypes.Mixed, default: null })
    response!: Record<string, unknown> | null;

    @Prop({ type: Date, required: true })
    expires_at!: Date;
}

export type IdempotencyKeyDocument = HydratedDocument<IdempotencyKey>;
export const IdempotencyKeySchema = SchemaFactory.createForClass(IdempotencyKey);

IdempotencyKeySchema.index(
    { scope: 1, user_id: 1, key: 1 },
    { unique: true, name: 'unique_idempotency_key' },
);
IdempotencyKeySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
