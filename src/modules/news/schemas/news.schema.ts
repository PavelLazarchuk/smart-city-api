import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';

@Schema(subSchemaOptions)
export class NewsContent {
    @Prop({ type: String }) heading_label?: string;
    @Prop({ type: String }) heading_value?: string;
    @Prop({ type: String }) text_label?: string;
    @Prop({ type: String }) text_value?: string;
    @Prop({ type: String }) image_label?: string;
    @Prop({ type: String }) image_value?: string;
    @Prop({ type: String }) link_label?: string;
    @Prop({ type: String }) link_value?: string;
}
export const NewsContentSchema = SchemaFactory.createForClass(NewsContent);

@Schema(baseSchemaOptions('news'))
export class News {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: Number, required: true, default: 0 })
    position!: number;

    @Prop({ type: String, required: true })
    label!: string;

    @Prop({ type: Boolean, required: true, default: false })
    enabled!: boolean;

    /** Publication date; promoted out of the bag so it can be sorted and indexed. */
    @Prop({ type: Date, required: true })
    date!: Date;

    @Prop({ type: Boolean, required: true, default: false })
    is_main!: boolean;

    @Prop({ type: Boolean, required: true, default: false })
    is_offer!: boolean;

    @Prop({ type: Date })
    expires_at?: Date;

    @Prop({ type: NewsContentSchema, required: true, default: () => ({}) })
    value!: NewsContent;
}

export type NewsDocument = HydratedDocument<News>;
export const NewsSchema = SchemaFactory.createForClass(News);
NewsSchema.index({ organization_id: 1, position: 1 });
NewsSchema.index({ is_main: 1, created_at: -1 }, { partialFilterExpression: { is_main: true } });
NewsSchema.index({ is_offer: 1, created_at: -1 }, { partialFilterExpression: { is_offer: true } });
NewsSchema.index({ expires_at: 1 });
