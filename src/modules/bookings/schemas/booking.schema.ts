import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed'];

/**
 * Own document: inside `services.options[].slots[]` every booking of a service shared one 16 MB document.
 * Occupancy stays denormalised as `booked_count`, because that is what the capacity guard compares.
 */
@Schema(baseSchemaOptions('bookings'))
export class Booking {
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

    @Prop({ type: String, required: true })
    child_type!: string;

    @Prop({ type: String, default: null })
    slot_date!: string | null;

    /** Only `date_time` slots have one; `null` keeps the uniqueness index total. */
    @Prop({ type: String, default: null })
    slot_time!: string | null;

    @Prop({ type: Date, default: null })
    starts_at!: Date | null;

    @Prop({ type: String, default: '' })
    service_label!: string;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    user_id!: Types.ObjectId;

    @Prop({ type: String, default: '' })
    person!: string;

    @Prop({ type: String, default: '' })
    phone!: string;

    @Prop({ type: String, default: '' })
    info!: string;

    @Prop({ type: SchemaTypes.Mixed, default: () => ({}) })
    fields!: Record<string, unknown>;

    @Prop({ type: [String], default: [] })
    documents!: string[];

    @Prop({ type: String, enum: BOOKING_STATUSES, required: true, default: 'confirmed' })
    status!: BookingStatus;

    /** Denormalised `status ∈ {pending, confirmed}`: what the partial unique index keys on. */
    @Prop({ type: Boolean, required: true, default: true })
    active!: boolean;

    @Prop({ type: Date, default: null })
    confirmed_at!: Date | null;

    @Prop({ type: Date, default: null })
    finished_at!: Date | null;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    status_changed_by!: Types.ObjectId | null;

    @Prop({ type: Date, default: null })
    reminder_sent_at!: Date | null;
}

export type BookingDocument = HydratedDocument<Booking>;
export const BookingSchema = SchemaFactory.createForClass(Booking);

BookingSchema.index({ id: 1 }, { unique: true });
/** Refuses a second active booking; partial on `active`, so a cancelled row does not block rebooking. */
BookingSchema.index(
    { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, user_id: 1 },
    { unique: true, name: 'unique_booking_per_slot', partialFilterExpression: { active: true } },
);
BookingSchema.index({ user_id: 1, created_at: -1 });
BookingSchema.index({ service_id: 1, created_at: -1 });
BookingSchema.index({ organization_id: 1, created_at: -1 });
BookingSchema.index({ organization_id: 1, slot_date: 1 });
BookingSchema.index({ active: 1, slot_date: 1, reminder_sent_at: 1 });
BookingSchema.index({ active: 1, starts_at: 1, reminder_sent_at: 1 });
BookingSchema.index({ organization_id: 1, status: 1, slot_date: 1 });
