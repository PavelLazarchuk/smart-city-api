import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../database/schema-options';

export const OUTBOX_EVENT_TYPES = [
    'booking.created',
    'booking.cancelled',
    'booking.rescheduled',
    'booking.status_changed',
    'booking.reminder',
    'waitlist.slot_available',
    'webhook.test',
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export const OUTBOX_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

@Schema(subSchemaOptions)
export class OutboxDelivery {
    @Prop({ type: String, required: true }) target!: string;
    @Prop({ type: String, enum: OUTBOX_STATUSES, required: true, default: 'pending' }) status!: OutboxStatus;
    @Prop({ type: Number, required: true, default: 0 }) attempts!: number;
    @Prop({ type: String }) last_error?: string;
    @Prop({ type: Date }) delivered_at?: Date;
}
export const OutboxDeliverySchema = SchemaFactory.createForClass(OutboxDelivery);

@Schema(baseSchemaOptions('outbox_events'))
export class OutboxEvent {
    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: String, enum: OUTBOX_EVENT_TYPES, required: true })
    type!: OutboxEventType;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    organization_id!: Types.ObjectId | null;

    @Prop({ type: SchemaTypes.Mixed, required: true, default: () => ({}) })
    payload!: Record<string, unknown>;

    @Prop({ type: SchemaTypes.Mixed, default: null })
    internal!: Record<string, unknown> | null;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    only_webhook_id!: Types.ObjectId | null;

    @Prop({ type: String, enum: OUTBOX_STATUSES, required: true, default: 'pending' })
    status!: OutboxStatus;

    @Prop({ type: Number, required: true, default: 0 })
    attempts!: number;

    @Prop({ type: Date, required: true, default: () => new Date() })
    next_attempt_at!: Date;

    @Prop({ type: Date, default: null })
    claimed_until!: Date | null;

    @Prop({ type: [OutboxDeliverySchema], default: [] })
    deliveries!: OutboxDelivery[];

    @Prop({ type: Date })
    delivered_at?: Date;

    @Prop({ type: String })
    last_error?: string;
}

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;
export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);
OutboxEventSchema.index({ id: 1 }, { unique: true });
OutboxEventSchema.index({ status: 1, next_attempt_at: 1 });
OutboxEventSchema.index({ organization_id: 1, created_at: -1 });
