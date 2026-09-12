import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

/**
 * A booking is its own document. It used to live inside `services.options[].slots[]` and be mirrored
 * in `users.bookings`, which put every booking of a service in one 16 MB document, funnelled all
 * concurrency for that service through it, and made "the bookings of one user" a collection scan.
 *
 * Occupancy stays denormalised as `booked_count` on the slot, because that is what the capacity
 * guard compares against in a single conditional update.
 */
@Schema(baseSchemaOptions('bookings'))
export class Booking {
    /** Public identifier, stable across the move out of the service document. */
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
}

export type BookingDocument = HydratedDocument<Booking>;
export const BookingSchema = SchemaFactory.createForClass(Booking);

BookingSchema.index({ id: 1 }, { unique: true });
/** Replaces the read-then-check for duplicates: a second identical booking cannot be inserted. */
BookingSchema.index(
    { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, user_id: 1 },
    { unique: true, name: 'unique_booking_per_slot' },
);
BookingSchema.index({ user_id: 1, created_at: -1 });
BookingSchema.index({ service_id: 1, created_at: -1 });
BookingSchema.index({ organization_id: 1, created_at: -1 });
