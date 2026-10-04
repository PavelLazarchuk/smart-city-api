import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

export const SETTINGS_DOCUMENT_ID = new Types.ObjectId('000000000000000000000001');

@Schema({ collection: 'settings', versionKey: false, minimize: false })
export class Settings {
    @Prop({ type: SchemaTypes.Mixed, default: {} })
    settings!: Record<string, unknown>;

    @Prop({ type: Date, default: null })
    updated_at!: Date | null;
}

export type SettingsDocument = HydratedDocument<Settings>;
export const SettingsSchema = SchemaFactory.createForClass(Settings);
