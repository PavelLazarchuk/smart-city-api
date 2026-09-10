import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

/** Refresh-token session; `_id` is the `sid` claim. Rotation links sessions through `replaced_by`. */
@Schema(baseSchemaOptions('sessions'))
export class Session {
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    user_id!: Types.ObjectId;

    /** Shared by every session produced by rotating the same original login (reuse detection). */
    @Prop({ type: SchemaTypes.ObjectId, required: true })
    family_id!: Types.ObjectId;

    @Prop({ type: String, required: true, select: false })
    refresh_token_hash!: string;

    @Prop({ type: SchemaTypes.ObjectId })
    replaced_by?: Types.ObjectId;

    @Prop({ type: Date })
    revoked_at?: Date;

    @Prop({ type: String })
    user_agent?: string;

    @Prop({ type: String })
    ip?: string;

    @Prop({ type: Date, required: true })
    expires_at!: Date;
}

export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ user_id: 1 });
SessionSchema.index({ family_id: 1 });
SessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
