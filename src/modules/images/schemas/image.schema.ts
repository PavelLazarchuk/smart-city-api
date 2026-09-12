import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

@Schema(baseSchemaOptions('images'))
export class Image {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    /** Storage key (path inside the provider). */
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
// `storage_gc` looks up whole batches of storage keys at a time.
ImageSchema.index({ name: 1 });
