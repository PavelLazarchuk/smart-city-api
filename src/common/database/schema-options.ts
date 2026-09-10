import { type SchemaOptions } from 'mongoose';

export const baseSchemaOptions = (collection: string): SchemaOptions => ({
    collection,
    versionKey: false,
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    minimize: false,
});

export const subSchemaOptions: SchemaOptions = { _id: false, versionKey: false, minimize: false };
