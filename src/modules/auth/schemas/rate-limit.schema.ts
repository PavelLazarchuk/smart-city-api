import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

/** Throttler storage shared across instances. `_id` is the throttler key. */
@Schema({ collection: 'rate_limits', versionKey: false, minimize: false })
export class RateLimit {
    @Prop({ type: String, required: true })
    _id!: string;

    @Prop({ type: Number, required: true, default: 0 })
    total_hits!: number;

    @Prop({ type: Date, required: true })
    expires_at!: Date;

    @Prop({ type: Date })
    blocked_until?: Date;
}

export type RateLimitDocument = HydratedDocument<RateLimit>;
export const RateLimitSchema = SchemaFactory.createForClass(RateLimit);
RateLimitSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
