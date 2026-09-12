import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';

export const SERVICE_TYPES = ['service_apply', 'service_payment', 'service_delivery'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SLOT_TYPES = ['date_time', 'date', 'apply', 'delivery', 'paycard'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];
export const BOOKABLE_SLOT_TYPES: readonly SlotType[] = ['date_time', 'date', 'apply'];

export const WEEKDAYS = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * One bookable time inside a `date_time` slot. The bookings themselves live in the `bookings`
 * collection; only the counter stays here, because the capacity guard is a conditional `$inc`.
 */
@Schema(subSchemaOptions)
export class TimeEntry {
    @Prop({ type: String, required: true }) time!: string;
    @Prop({ type: Number, default: null }) limit!: number | null;
    @Prop({ type: Number, required: true, default: 0 }) booked_count!: number;
}
export const TimeEntrySchema = SchemaFactory.createForClass(TimeEntry);

/** Superset of every `child_type` value shape; exact shapes are enforced by zod. */
@Schema(subSchemaOptions)
export class SlotValue {
    @Prop({ type: String }) date?: string;
    @Prop({ type: [TimeEntrySchema] }) time?: TimeEntry[];
    @Prop({ type: Number, default: undefined }) limit?: number | null;
    @Prop({ type: Number }) booked_count?: number;
    @Prop({ type: String }) description?: string;
    @Prop({ type: String }) link?: string;
    @Prop({ type: String }) price?: string;
}
export const SlotValueSchema = SchemaFactory.createForClass(SlotValue);

@Schema(subSchemaOptions)
export class Slot {
    @Prop({ type: String, required: true }) id!: string;
    @Prop({ type: String, required: true }) label!: string;
    @Prop({ type: String, enum: SLOT_TYPES, required: true }) child_type!: SlotType;
    @Prop({ type: SlotValueSchema, required: true, default: () => ({}) }) value!: SlotValue;
}
export const SlotSchema = SchemaFactory.createForClass(Slot);

@Schema(subSchemaOptions)
export class RecurrentTime {
    @Prop({ type: String, required: true }) time!: string;
    @Prop({ type: Number, default: null }) limit!: number | null;
}
export const RecurrentTimeSchema = SchemaFactory.createForClass(RecurrentTime);

@Schema(subSchemaOptions)
export class RecurrentDate {
    @Prop({ type: String, enum: WEEKDAYS, required: true }) day!: Weekday;
    @Prop({ type: [RecurrentTimeSchema], default: [] }) time!: RecurrentTime[];
}
export const RecurrentDateSchema = SchemaFactory.createForClass(RecurrentDate);

@Schema(subSchemaOptions)
export class ServiceOption {
    @Prop({ type: String, required: true }) id!: string;
    @Prop({ type: String, required: true }) label!: string;
    @Prop({ type: String, enum: SERVICE_TYPES, required: true, default: 'service_apply' })
    service_type!: ServiceType;
    @Prop({ type: Boolean, required: true, default: true }) enabled!: boolean;
    @Prop({ type: [RecurrentDateSchema], default: undefined }) recurrent_dates?: RecurrentDate[];
    @Prop({ type: [SlotSchema], default: [] }) slots!: Slot[];
}
export const ServiceOptionSchema = SchemaFactory.createForClass(ServiceOption);

@Schema(subSchemaOptions)
export class ServiceContent {
    @Prop({ type: String }) heading_label?: string;
    @Prop({ type: String }) heading_value?: string;
    @Prop({ type: String }) text_label?: string;
    @Prop({ type: String }) text_value?: string;
    @Prop({ type: String }) image_label?: string;
    @Prop({ type: String }) image_value?: string;
    @Prop({ type: String }) price_label?: string;
    @Prop({ type: String }) price_value?: string;
    @Prop({ type: String }) link_label?: string;
    @Prop({ type: String }) link_value?: string;
    /** Internal notification address — admin-only in responses. */
    @Prop({ type: String }) subscribe?: string;
}
export const ServiceContentSchema = SchemaFactory.createForClass(ServiceContent);

@Schema(baseSchemaOptions('services'))
export class Service {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    category_id!: Types.ObjectId | null;

    @Prop({ type: Number, required: true, default: 0 })
    position!: number;

    @Prop({ type: String, required: true })
    label!: string;

    @Prop({ type: Boolean, required: true, default: false })
    enabled!: boolean;

    @Prop({ type: ServiceContentSchema, required: true, default: () => ({}) })
    value!: ServiceContent;

    @Prop({ type: [ServiceOptionSchema], default: [] })
    options!: ServiceOption[];
}

export type ServiceDocument = HydratedDocument<Service>;
export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.index({ organization_id: 1, category_id: 1, position: 1 });
ServiceSchema.index({ category_id: 1 });
ServiceSchema.index({ organization_id: 1, enabled: 1, position: 1 });
