import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, type Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const OTP_PURPOSES = ['login', 'phone_change'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

@Schema(baseSchemaOptions('verification_codes'))
export class VerificationCode {
    @Prop({ type: String, required: true })
    phone!: string;

    @Prop({ type: String, required: true, select: false })
    code_hash!: string;

    @Prop({ type: String, enum: OTP_PURPOSES, required: true, default: 'login' })
    purpose!: OtpPurpose;

    @Prop({ type: SchemaTypes.ObjectId })
    user_id?: Types.ObjectId;

    @Prop({ type: Number, required: true, default: 0 })
    attempts!: number;

    @Prop({ type: Date })
    consumed_at?: Date;

    @Prop({ type: Date, required: true })
    expires_at!: Date;
}

export type VerificationCodeDocument = HydratedDocument<VerificationCode>;
export const VerificationCodeSchema = SchemaFactory.createForClass(VerificationCode);
VerificationCodeSchema.index({ phone: 1 });
VerificationCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
