import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { SEARCH_DEFAULT_LANGUAGE } from '../../../common/config/constants';
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

    @Prop({ type: String })
    slug?: string;

    @Prop({ type: String })
    rubric?: string;

    @Prop({ type: Boolean, required: true, default: false })
    enabled!: boolean;

    @Prop({ type: Date, default: null })
    publish_at!: Date | null;

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
NewsSchema.index(
    { organization_id: 1, slug: 1 },
    {
        unique: true,
        partialFilterExpression: { slug: { $type: 'string' } },
        name: 'unique_slug_per_organization',
    },
);
NewsSchema.index({ rubric: 1, date: -1 });
NewsSchema.index({ publish_at: 1 });
NewsSchema.index(
    { label: 'text', 'value.heading_value': 'text', 'value.text_value': 'text' },
    {
        name: 'news_text',
        default_language: SEARCH_DEFAULT_LANGUAGE,
        weights: { label: 10, 'value.heading_value': 6, 'value.text_value': 1 },
    },
);
