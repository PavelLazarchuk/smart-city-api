import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const WAITLIST_STATUSES = ['waiting', 'notified'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

@Schema(baseSchemaOptions('waitlist'))
export class WaitlistEntry {
    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    service_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, required: true })
    option_id!: string;

    @Prop({ type: String, required: true })
    slot_id!: string;

    @Prop({ type: String, default: null })
    slot_date!: string | null;

    @Prop({ type: String, default: null })
    slot_time!: string | null;

    @Prop({ type: String, default: '' })
    service_label!: string;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    user_id!: Types.ObjectId;

    @Prop({ type: String, default: '' })
    person!: string;

    @Prop({ type: String, default: '' })
    phone!: string;

    @Prop({ type: String, enum: WAITLIST_STATUSES, required: true, default: 'waiting' })
    status!: WaitlistStatus;

    @Prop({ type: Date, default: null })
    notified_at!: Date | null;
}

export type WaitlistEntryDocument = HydratedDocument<WaitlistEntry>;
export const WaitlistEntrySchema = SchemaFactory.createForClass(WaitlistEntry);
WaitlistEntrySchema.index({ id: 1 }, { unique: true });
WaitlistEntrySchema.index(
    { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, user_id: 1 },
    { unique: true, name: 'unique_waitlist_per_slot' },
);
WaitlistEntrySchema.index({
    service_id: 1,
    option_id: 1,
    slot_id: 1,
    slot_time: 1,
    status: 1,
    created_at: 1,
});
WaitlistEntrySchema.index({ user_id: 1, created_at: -1 });
WaitlistEntrySchema.index({ organization_id: 1 });
