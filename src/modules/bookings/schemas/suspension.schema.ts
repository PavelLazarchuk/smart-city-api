import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const SUSPENSION_KINDS = ['no_show', 'manual'] as const;
export type SuspensionKind = (typeof SUSPENSION_KINDS)[number];

@Schema(baseSchemaOptions('booking_suspensions'))
export class BookingSuspension {
    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    user_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    service_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, default: '' })
    service_label!: string;

    @Prop({ type: Boolean, required: true, default: false })
    suspended!: boolean;

    @Prop({ type: Date, default: null })
    until!: Date | null;

    @Prop({ type: String, enum: SUSPENSION_KINDS, default: null })
    kind!: SuspensionKind | null;

    @Prop({ type: String, default: null })
    reason!: string | null;

    @Prop({ type: [String], default: [] })
    booking_ids!: string[];

    @Prop({ type: Date, default: null })
    counted_from!: Date | null;

    @Prop({ type: Date, default: null })
    suspended_at!: Date | null;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    suspended_by!: Types.ObjectId | null;

    @Prop({ type: Date, default: null })
    lifted_at!: Date | null;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    lifted_by!: Types.ObjectId | null;

    @Prop({ type: Date, default: null })
    touched_at!: Date | null;
}

export type BookingSuspensionDocument = HydratedDocument<BookingSuspension>;
export const BookingSuspensionSchema = SchemaFactory.createForClass(BookingSuspension);
BookingSuspensionSchema.index({ id: 1 }, { unique: true });
BookingSuspensionSchema.index(
    { user_id: 1, service_id: 1 },
    { unique: true, name: 'unique_suspension_per_service' },
);
BookingSuspensionSchema.index({ service_id: 1 });
BookingSuspensionSchema.index({ organization_id: 1, suspended_at: -1 });
