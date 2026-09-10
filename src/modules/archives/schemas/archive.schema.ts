import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Schema as MongooseSchema, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const ARCHIVE_TYPES = ['news', 'service'] as const;
export type ArchiveType = (typeof ARCHIVE_TYPES)[number];

/** JSON snapshot of an expired news item or service slot; retention by TTL index. */
@Schema(baseSchemaOptions('archives'))
export class Archive {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId })
    service_id?: Types.ObjectId;

    @Prop({ type: String, enum: ARCHIVE_TYPES, required: true })
    type!: ArchiveType;

    @Prop({ type: MongooseSchema.Types.Mixed, required: true })
    data!: Record<string, unknown>;
}

export type ArchiveDocument = HydratedDocument<Archive>;

/**
 * Retention lives in the migration only (`ARCHIVE_RETENTION_DAYS` → TTL on `created_at`): with
 * `autoIndex` off in production, a TTL declared here would apply in dev but be ignored in prod.
 * Changing retention is a `collMod` migration — see `docs/deployment.md`.
 */
export const ArchiveSchema: MongooseSchema<Archive> = (() => {
    const schema = SchemaFactory.createForClass(Archive);
    schema.index({ organization_id: 1, created_at: -1 });
    schema.index({ service_id: 1 });

    return schema;
})();
