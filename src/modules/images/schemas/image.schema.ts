import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

@Schema(baseSchemaOptions('images'))
export class Image {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, required: true })
    name!: string;

    @Prop({ type: String, required: true })
    src!: string;

    @Prop({ type: String, required: true })
    mime_type!: string;

    @Prop({ type: Number, required: true })
    size!: number;
}

export type ImageDocument = HydratedDocument<Image>;
export const ImageSchema = SchemaFactory.createForClass(Image);
ImageSchema.index({ organization_id: 1, created_at: -1 });
ImageSchema.index({ name: 1 });
ImageSchema.index({ src: 1 });
