import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';

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
}

export type OrganizationDocument = HydratedDocument<Organization>;
export const OrganizationSchema = SchemaFactory.createForClass(Organization);
OrganizationSchema.index({ main_category: 1 });
OrganizationSchema.index({ created_at: -1 });
OrganizationSchema.index({ main_label: 'text' });
