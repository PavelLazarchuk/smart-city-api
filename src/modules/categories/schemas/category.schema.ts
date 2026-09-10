import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

/** A category is always one level: it contains services only. */
@Schema(baseSchemaOptions('categories'))
export class Category {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: Number, required: true, default: 0 })
    position!: number;

    @Prop({ type: String, required: true })
    label!: string;

    @Prop({ type: String })
    description?: string;

    @Prop({ type: Boolean, required: true, default: false })
    enabled!: boolean;
}

export type CategoryDocument = HydratedDocument<Category>;
export const CategorySchema = SchemaFactory.createForClass(Category);
CategorySchema.index({ organization_id: 1, position: 1 });
