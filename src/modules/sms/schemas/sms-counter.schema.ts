import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

/** One document per budget window; `_id` is `sms:<window>:<bucket>`, e.g. `sms:day:2026-09-10`. */
@Schema({ collection: 'sms_counters', versionKey: false, minimize: false })
export class SmsCounter {
    @Prop({ type: String, required: true })
    _id!: string;

    @Prop({ type: Number, required: true, default: 0 })
    count!: number;

    @Prop({ type: Date, required: true })
    expires_at!: Date;
}

export type SmsCounterDocument = HydratedDocument<SmsCounter>;
export const SmsCounterSchema = SchemaFactory.createForClass(SmsCounter);
SmsCounterSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
