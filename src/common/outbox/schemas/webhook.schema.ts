import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../database/schema-options';
import { OUTBOX_EVENT_TYPES, type OutboxEventType } from './outbox-event.schema';

@Schema(baseSchemaOptions('webhooks'))
export class Webhook {
    @Prop({ type: SchemaTypes.ObjectId, default: null })
    organization_id!: Types.ObjectId | null;

    @Prop({ type: String, required: true })
    url!: string;

    @Prop({ type: String, required: true, select: false })
    secret!: string;

    @Prop({ type: [String], enum: OUTBOX_EVENT_TYPES, required: true, default: [] })
    events!: OutboxEventType[];

    @Prop({ type: Boolean, required: true, default: true })
    enabled!: boolean;

    @Prop({ type: String })
    description?: string;

    @Prop({ type: Date })
    last_delivery_at?: Date;

    @Prop({ type: Date })
    last_failure_at?: Date;

    @Prop({ type: String })
    last_error?: string;

    @Prop({ type: Number, required: true, default: 0 })
    consecutive_failures!: number;
}

export type WebhookDocument = HydratedDocument<Webhook>;
export const WebhookSchema = SchemaFactory.createForClass(Webhook);
WebhookSchema.index({ organization_id: 1, created_at: -1 });
WebhookSchema.index({ enabled: 1, events: 1 });
