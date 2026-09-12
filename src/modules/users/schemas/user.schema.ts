import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';
import { type Role, ROLE_VALUES, ROLES } from '../../../common/decorators/roles.decorator';

@Schema(baseSchemaOptions('users'))
export class User {
    /** Admin identifier. Citizens have no login at all. */
    @Prop({ type: String })
    login?: string;

    /** argon2id hash; never serialized. */
    @Prop({ type: String, select: false })
    password_hash?: string;

    @Prop({ type: String })
    name?: string;

    /** Citizen identifier in E.164 digits. Admins may have one for SMS login. */
    @Prop({ type: String })
    phone?: string;

    @Prop({ type: String, enum: ROLE_VALUES, required: true, default: ROLES.COMMON_USER })
    role!: Role;

    /** The only place organization membership is stored. */
    @Prop({ type: [SchemaTypes.ObjectId], default: [] })
    organization_ids!: Types.ObjectId[];

    /** Failed password logins inside the current window; reset by a successful one or by the window. */
    @Prop({ type: Number, required: true, default: 0 })
    failed_login_attempts!: number;

    /** When the counter was last raised; anything older than the window starts the count over. */
    @Prop({ type: Date })
    last_failed_login_at?: Date;

    /** Set once the failure budget is spent; password login is refused until it passes. */
    @Prop({ type: Date })
    locked_until?: Date;
}

export type UserDocument = HydratedDocument<User>;

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ login: 1 }, { unique: true, partialFilterExpression: { login: { $type: 'string' } } });
UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
UserSchema.index({ organization_ids: 1 });
