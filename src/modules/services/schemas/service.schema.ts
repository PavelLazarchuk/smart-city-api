import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';

export const SERVICE_TYPES = ['service_apply', 'service_payment', 'service_delivery'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SLOT_TYPES = ['date_time', 'date', 'apply', 'delivery', 'paycard'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];
export const BOOKABLE_SLOT_TYPES: readonly SlotType[] = ['date_time', 'date', 'apply'];

export const SERVICE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const FORM_FIELD_TYPES = [
    'text',
    'textarea',
    'number',
    'date',
    'boolean',
    'select',
    'phone',
    'email',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

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
    @Prop({ type: Number, default: null }) limit?: number | null;
}
export const RecurrentDateSchema = SchemaFactory.createForClass(RecurrentDate);

@Schema(subSchemaOptions)
export class WorkingHours {
    @Prop({ type: String, enum: WEEKDAYS, required: true }) day!: Weekday;
    @Prop({ type: String, required: true }) from!: string;
    @Prop({ type: String, required: true }) to!: string;
}
export const WorkingHoursSchema = SchemaFactory.createForClass(WorkingHours);

@Schema(subSchemaOptions)
export class GeoPoint {
    @Prop({ type: String, enum: ['Point'], required: true, default: 'Point' }) type!: 'Point';
    @Prop({ type: [Number], required: true }) coordinates!: number[];
}
export const GeoPointSchema = SchemaFactory.createForClass(GeoPoint);

@Schema(subSchemaOptions)
export class BookingPolicy {
    @Prop({ type: Number, default: null }) max_active_per_user!: number | null;
    @Prop({ type: Number, default: null }) lead_time_minutes!: number | null;
    @Prop({ type: Number, default: null }) max_advance_days!: number | null;
    @Prop({ type: Number, default: null }) cancel_deadline_minutes!: number | null;
    @Prop({ type: Boolean, required: true, default: false }) requires_confirmation!: boolean;
}
export const BookingPolicySchema = SchemaFactory.createForClass(BookingPolicy);

@Schema(subSchemaOptions)
export class FormField {
    @Prop({ type: String, required: true }) key!: string;
    @Prop({ type: String, required: true }) label!: string;
    @Prop({ type: String, enum: FORM_FIELD_TYPES, required: true }) type!: FormFieldType;
    @Prop({ type: Boolean, required: true, default: false }) required!: boolean;
    @Prop({ type: [String], default: undefined }) options?: string[];
    @Prop({ type: String }) placeholder?: string;
    @Prop({ type: Number, default: null }) max_length!: number | null;
}
export const FormFieldSchema = SchemaFactory.createForClass(FormField);

@Schema(subSchemaOptions)
export class RequiredDocument {
    @Prop({ type: String, required: true }) key!: string;
    @Prop({ type: String, required: true }) label!: string;
    @Prop({ type: Boolean, required: true, default: true }) required!: boolean;
}
export const RequiredDocumentSchema = SchemaFactory.createForClass(RequiredDocument);

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

    @Prop({ type: String })
    slug?: string;

    /**
     * `enabled` is kept in step with `status === 'published'` on every write: older clients and the
     * `{ organization_id, enabled, position }` index keep working, and `status` is the source of truth.
     */
    @Prop({ type: Boolean, required: true, default: false })
    enabled!: boolean;

    @Prop({ type: String, enum: SERVICE_STATUSES, required: true, default: 'draft' })
    status!: ServiceStatus;

    @Prop({ type: Date, default: null })
    published_at!: Date | null;

    @Prop({ type: String })
    description?: string;

    @Prop({ type: [String], default: [] })
    tags!: string[];

    @Prop({ type: Number, default: null })
    duration_minutes!: number | null;

    @Prop({ type: Number, default: null })
    buffer_minutes!: number | null;

    @Prop({ type: Number, default: null })
    price!: number | null;

    @Prop({ type: String })
    currency?: string;

    @Prop({ type: String })
    address?: string;

    @Prop({ type: GeoPointSchema, default: undefined })
    location?: GeoPoint;

    @Prop({ type: [WorkingHoursSchema], default: [] })
    working_hours!: WorkingHours[];

    @Prop({ type: [String], default: [] })
    holidays!: string[];

    @Prop({ type: [String], default: [] })
    blackout_dates!: string[];

    @Prop({ type: BookingPolicySchema, required: true, default: () => ({}) })
    booking_policy!: BookingPolicy;

    @Prop({ type: [FormFieldSchema], default: [] })
    form_fields!: FormField[];

    @Prop({ type: [RequiredDocumentSchema], default: [] })
    required_documents!: RequiredDocument[];

    @Prop({ type: ServiceContentSchema, required: true, default: () => ({}) })
    value!: ServiceContent;

    @Prop({ type: [ServiceOptionSchema], default: [] })
    options!: ServiceOption[];

    @Prop({ type: Date, default: null })
    deleted_at!: Date | null;
}

export type ServiceDocument = HydratedDocument<Service>;
export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.index({ organization_id: 1, category_id: 1, position: 1 });
ServiceSchema.index({ category_id: 1 });
ServiceSchema.index({ organization_id: 1, enabled: 1, position: 1 });
ServiceSchema.index(
    { organization_id: 1, slug: 1 },
    {
        unique: true,
        partialFilterExpression: { slug: { $type: 'string' } },
        name: 'unique_slug_per_organization',
    },
);
ServiceSchema.index({ status: 1, deleted_at: 1 });
ServiceSchema.index({ tags: 1 });
ServiceSchema.index({ deleted_at: 1 });
ServiceSchema.index({ location: '2dsphere' });
ServiceSchema.index(
    {
        description: 'text',
        label: 'text',
        tags: 'text',
        'value.heading_value': 'text',
        'value.text_value': 'text',
    },
    {
        name: 'service_text',
        weights: { description: 3, label: 10, tags: 8, 'value.heading_value': 6, 'value.text_value': 1 },
    },
);
