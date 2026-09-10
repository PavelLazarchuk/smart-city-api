import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';
import { type Role, ROLE_VALUES, ROLES } from '../../../common/decorators/roles.decorator';

/** A user's reference to a booking that lives inside a service slot. */
@Schema(subSchemaOptions)
export class BookingRef {
    @Prop({ type: String, required: true })
    id!: string;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    service_id!: Types.ObjectId;

    @Prop({ type: SchemaTypes.ObjectId, required: true })
    organization_id!: Types.ObjectId;

    @Prop({ type: String, required: true })
    option_id!: string;

    @Prop({ type: String, required: true })
    slot_id!: string;

    @Prop({ type: String, required: true })
    child_type!: string;

    @Prop({ type: String })
    service_label?: string;

    @Prop({ type: String })
    date?: string;

    @Prop({ type: String })
    time?: string;

    @Prop({ type: Date, required: true })
    created_at!: Date;
}

export const BookingRefSchema = SchemaFactory.createForClass(BookingRef);

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

    @Prop({ type: [BookingRefSchema], default: [] })
    bookings!: BookingRef[];
}

export type UserDocument = HydratedDocument<User>;

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ login: 1 }, { unique: true, partialFilterExpression: { login: { $type: 'string' } } });
UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
UserSchema.index({ organization_ids: 1 });
