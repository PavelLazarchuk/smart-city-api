import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';
import { CHANNEL_TEMPLATE_KEYS, type ChannelTemplateKey } from '../channel-catalogue';

@Schema(baseSchemaOptions('channel_templates'))
export class ChannelTemplate {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, enum: CHANNEL_TEMPLATE_KEYS, required: true })
    key!: ChannelTemplateKey;

    @Prop({ type: String, default: null })
    subject!: string | null;

    @Prop({ type: String, required: true })
    body!: string;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    updated_by!: Types.ObjectId | null;
}

export type ChannelTemplateDocument = HydratedDocument<ChannelTemplate>;
export const ChannelTemplateSchema = SchemaFactory.createForClass(ChannelTemplate);
ChannelTemplateSchema.index(
    { organization_id: 1, key: 1 },
    { unique: true, name: 'unique_template_per_organization' },
);
