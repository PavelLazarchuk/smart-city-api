import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const SMS_PURPOSES = [
    'verification',
    'test',
    'reminder',
    'waitlist',
    'cancellation',
    'reschedule',
] as const;
export type SmsPurpose = (typeof SMS_PURPOSES)[number];

export const SMS_STATUSES = ['sent', 'failed', 'blocked'] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

@Schema(baseSchemaOptions('sms'))
export class Sms {
    @Prop({ type: String, required: true })
    phone!: string;

    @Prop({ type: String, enum: SMS_PURPOSES, required: true })
    purpose!: SmsPurpose;

    @Prop({ type: String, required: true })
    provider!: string;

    @Prop({ type: String, enum: SMS_STATUSES, required: true })
    status!: SmsStatus;
}

export type SmsDocument = HydratedDocument<Sms>;
export const SmsSchema = SchemaFactory.createForClass(Sms);
SmsSchema.index({ created_at: -1 });
SmsSchema.index({ phone: 1, created_at: -1 });
