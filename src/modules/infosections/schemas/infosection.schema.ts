import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';

export const INFO_SECTION_CONTROLS = ['text', 'address', 'link', 'phone', 'email'] as const;
export type InfoSectionControl = (typeof INFO_SECTION_CONTROLS)[number];

/** Superset of every `control` shape; the exact shape per control is enforced by zod. */
@Schema(subSchemaOptions)
export class InfoSectionContent {
    @Prop({ type: String }) heading_label?: string;
    @Prop({ type: String }) heading_value?: string;
    @Prop({ type: String }) text_label?: string;
    @Prop({ type: String }) text_value?: string;
    @Prop({ type: String }) text?: string;
    @Prop({ type: String }) lat?: string;
    @Prop({ type: String }) lng?: string;
    @Prop({ type: String }) url?: string;
    @Prop({ type: String }) phone?: string;
    @Prop({ type: String }) email?: string;
}
export const InfoSectionContentSchema = SchemaFactory.createForClass(InfoSectionContent);

@Schema(baseSchemaOptions('infosections'))
export class InfoSection {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: Number, required: true, default: 0 })
    position!: number;

    @Prop({ type: String, required: true })
    label!: string;

    @Prop({ type: Boolean, required: true, default: false })
    enabled!: boolean;

    @Prop({ type: String, enum: INFO_SECTION_CONTROLS, required: true })
    control!: InfoSectionControl;

    @Prop({ type: InfoSectionContentSchema, required: true, default: () => ({}) })
    value!: InfoSectionContent;
}

export type InfoSectionDocument = HydratedDocument<InfoSection>;
export const InfoSectionSchema = SchemaFactory.createForClass(InfoSection);
InfoSectionSchema.index({ organization_id: 1, position: 1 });
