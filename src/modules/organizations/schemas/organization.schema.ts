import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

import { baseSchemaOptions, subSchemaOptions } from '../../../common/database/schema-options';
import {
    GeoPointSchema,
    type GeoPoint,
    WorkingHoursSchema,
    type WorkingHours,
} from '../../services/schemas/service.schema';

export const ORGANIZATION_STATUSES = ['active', 'temporarily_closed'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

@Schema(subSchemaOptions)
export class OrganizationBookingPolicy {
    @Prop({ type: Number, default: null }) max_active_per_user!: number | null;
    @Prop({ type: Number, default: null }) min_interval_days!: number | null;
}
export const OrganizationBookingPolicySchema = SchemaFactory.createForClass(OrganizationBookingPolicy);

/** An organization holds no child references — children point at it. */
@Schema(baseSchemaOptions('organizations'))
export class Organization {
    @Prop({ type: String, required: true })
    main_label!: string;

    @Prop({ type: String })
    category?: string;

    @Prop({ type: String })
    main_category?: string;

    @Prop({ type: String, required: true })
    main_image!: string;

    @Prop({ type: String, enum: ORGANIZATION_STATUSES, required: true, default: 'active' })
    status!: OrganizationStatus;

    @Prop({ type: String })
    closed_reason?: string;

    @Prop({ type: Date, default: null })
    closed_until!: Date | null;

    @Prop({ type: String })
    address?: string;

    @Prop({ type: GeoPointSchema, default: undefined })
    location?: GeoPoint;

    @Prop({ type: [WorkingHoursSchema], default: [] })
    working_hours!: WorkingHours[];

    @Prop({ type: [String], default: [] })
    holidays!: string[];

    @Prop({ type: String, required: true, default: 'UTC' })
    timezone!: string;

    @Prop({ type: OrganizationBookingPolicySchema, default: undefined })
    booking_policy?: OrganizationBookingPolicy;

    @Prop({ type: Number, required: true, default: 0 })
    version!: number;
}

export type OrganizationDocument = HydratedDocument<Organization>;
export const OrganizationSchema = SchemaFactory.createForClass(Organization);
OrganizationSchema.index({ main_category: 1 });
OrganizationSchema.index({ created_at: -1 });
OrganizationSchema.index({ main_label: 'text' });
OrganizationSchema.index({ status: 1 });
OrganizationSchema.index({ location: '2dsphere' });
