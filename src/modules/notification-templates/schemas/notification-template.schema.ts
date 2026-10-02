import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';
import { NOTIFICATION_KEYS, type NotificationKey } from '../notification-catalogue';

@Schema(baseSchemaOptions('notification_templates'))
export class NotificationTemplate {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, enum: NOTIFICATION_KEYS, required: true })
    key!: NotificationKey;

    @Prop({ type: String, default: null })
    subject!: string | null;

    @Prop({ type: String, required: true })
    body!: string;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    updated_by!: Types.ObjectId | null;
}

export type NotificationTemplateDocument = HydratedDocument<NotificationTemplate>;
export const NotificationTemplateSchema = SchemaFactory.createForClass(NotificationTemplate);
NotificationTemplateSchema.index(
    { organization_id: 1, key: 1 },
    { unique: true, name: 'unique_template_per_organization' },
);
