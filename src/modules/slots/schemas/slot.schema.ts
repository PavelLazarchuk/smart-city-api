import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';
import { SLOT_TYPES, type SlotType } from '../../services/schemas/service.schema';

@Schema(subSchemaOptions)
export class TimeEntry {
    @Prop({ type: String, required: true }) time!: string;
    @Prop({ type: Number, default: null }) limit!: number | null;
    @Prop({ type: Number, required: true, default: 0 }) booked_count!: number;
}
export const TimeEntrySchema = SchemaFactory.createForClass(TimeEntry);

@Schema(subSchemaOptions)
export class SlotValue {
    @Prop({ type: String }) date?: string;
    @Prop({ type: [TimeEntrySchema], default: undefined }) time?: TimeEntry[];
    @Prop({ type: Number, default: undefined }) limit?: number | null;
    @Prop({ type: Number }) booked_count?: number;
    @Prop({ type: String }) description?: string;
    @Prop({ type: String }) link?: string;
    @Prop({ type: String }) price?: string;
}
export const SlotValueSchema = SchemaFactory.createForClass(SlotValue);

@Schema(baseSchemaOptions('slots'))
export class Slot {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    service_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, required: true })
    option_id!: string;

    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: String, required: true })
    label!: string;

    @Prop({ type: String, enum: SLOT_TYPES, required: true })
    child_type!: SlotType;

    @Prop({ type: SlotValueSchema, required: true, default: () => ({}) })
    value!: SlotValue;
}

export type SlotBody = Pick<Slot, 'id' | 'label' | 'child_type' | 'value'>;

export type SlotDocument = HydratedDocument<Slot>;
export const SlotSchema = SchemaFactory.createForClass(Slot);
SlotSchema.index({ service_id: 1, option_id: 1, id: 1 }, { unique: true, name: 'unique_slot_per_option' });
SlotSchema.index({ organization_id: 1 });
SlotSchema.index({ 'value.date': 1 }, { partialFilterExpression: { 'value.date': { $type: 'string' } } });
