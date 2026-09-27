import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const FAVORITE_TYPES = ['service', 'organization'] as const;
export type FavoriteType = (typeof FAVORITE_TYPES)[number];

@Schema(baseSchemaOptions('favorites'))
export class Favorite {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    user_id!: Types.ObjectId;

    @Prop({ type: String, enum: FAVORITE_TYPES, required: true })
    type!: FavoriteType;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    target_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;
}

export type FavoriteDocument = HydratedDocument<Favorite>;
export const FavoriteSchema = SchemaFactory.createForClass(Favorite);
FavoriteSchema.index({ user_id: 1, type: 1, target_id: 1 }, { unique: true, name: 'unique_favorite' });
FavoriteSchema.index({ user_id: 1, created_at: -1 });
FavoriteSchema.index({ target_id: 1 });
FavoriteSchema.index({ organization_id: 1 });
