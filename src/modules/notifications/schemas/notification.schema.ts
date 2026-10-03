import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';
import {
    NOTIFICATION_AUDIENCES,
    NOTIFICATION_STATUSES,
    NOTIFICATION_TYPES,
    type NotificationAudience,
    type NotificationData,
    type NotificationStatus,
    type NotificationType,
} from '../notification-rules';

@Schema(baseSchemaOptions('notifications'))
export class Notification {
    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: String, enum: NOTIFICATION_AUDIENCES, required: true })
    audience!: NotificationAudience;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    user_id!: Types.ObjectId | null;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, default: '' })
    organization_label!: string;

    @Prop({ type: String, enum: NOTIFICATION_TYPES, required: true })
    type!: NotificationType;

    @Prop({ type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'unread' })
    status!: NotificationStatus;

    @Prop({ type: Date, default: null })
    read_at!: Date | null;

    @Prop({ type: String, required: true })
    title!: string;

    @Prop({ type: String, required: true })
    body!: string;

    @Prop({ type: SchemaTypes.Mixed, default: () => ({}) })
    data!: NotificationData;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    subject_user_id!: Types.ObjectId | null;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    sender_id!: Types.ObjectId | null;

    @Prop({ type: String, default: null })
    message_id!: string | null;

    @Prop({ type: String, default: null })
    source_event_id!: string | null;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ id: 1 }, { unique: true, name: 'id_1' });
NotificationSchema.index(
    { user_id: 1, status: 1, created_at: -1, _id: -1 },
    { name: 'user_id_1_status_1_created_at_-1__id_-1' },
);
NotificationSchema.index(
    { organization_id: 1, audience: 1, status: 1, created_at: -1, _id: -1 },
    { name: 'organization_id_1_audience_1_status_1_created_at_-1__id_-1' },
);
NotificationSchema.index(
    { source_event_id: 1, audience: 1 },
    {
        unique: true,
        name: 'unique_notification_per_event',
        partialFilterExpression: { source_event_id: { $type: 'string' } },
    },
);
NotificationSchema.index(
    { subject_user_id: 1 },
    { name: 'subject_user_id_1', partialFilterExpression: { audience: 'staff' } },
);
