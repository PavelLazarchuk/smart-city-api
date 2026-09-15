import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, SchemaTypes, Types } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

export const REVISION_ACTIONS = [
    'create',
    'update',
    'status',
    'delete',
    'restore',
    'option.add',
    'option.update',
    'option.remove',
    'option.recurrence',
    'slot.add',
    'slot.update',
    'slot.remove',
] as const;
export type RevisionAction = (typeof REVISION_ACTIONS)[number];

@Schema(baseSchemaOptions('service_revisions'))
export class ServiceRevision {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    service_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, enum: REVISION_ACTIONS, required: true })
    action!: RevisionAction;

    @Prop({ type: SchemaTypes.ObjectId, default: null })
    actor_id!: Types.ObjectId | null;

    @Prop({ type: String, default: null })
    actor_role!: string | null;

    @Prop({ type: SchemaTypes.Mixed, required: true, default: () => ({}) })
    changes!: Record<string, { before: unknown; after: unknown }>;
}

export type ServiceRevisionDocument = HydratedDocument<ServiceRevision>;
export const ServiceRevisionSchema = SchemaFactory.createForClass(ServiceRevision);
ServiceRevisionSchema.index({ service_id: 1, created_at: -1 });
ServiceRevisionSchema.index({ organization_id: 1, created_at: -1 });
