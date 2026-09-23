import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types, SchemaTypes } from 'mongoose';

import { baseSchemaOptions } from '../../../common/database/schema-options';
import { EVENT_TYPE_VALUES, type EventType } from '../../../common/decorators/track-event.decorator';

@Schema(baseSchemaOptions('analytics_events'))
export class AnalyticsEvent {
    @Prop({ type: String, enum: EVENT_TYPE_VALUES, required: true })
    type!: EventType;

    @Prop({ type: SchemaTypes.ObjectId }) user_id?: Types.ObjectId;
    @Prop({ type: String }) user_role?: string;
    @Prop({ type: String }) user_name?: string;
    @Prop({ type: String }) user_phone?: string;
    @Prop({ type: SchemaTypes.ObjectId }) organization_id?: Types.ObjectId;
    @Prop({ type: String }) organization_label?: string;
    @Prop({ type: SchemaTypes.ObjectId }) service_id?: Types.ObjectId;
    @Prop({ type: String }) service_label?: string;
    @Prop({ type: String }) service_type?: string;
    @Prop({ type: String }) child_type?: string;
    @Prop({ type: String }) date?: string;
    @Prop({ type: String }) time?: string;
    @Prop({ type: String }) request_id?: string;
    @Prop({ type: String }) source?: string;
}

export type AnalyticsEventDocument = HydratedDocument<AnalyticsEvent>;
export const AnalyticsEventSchema = SchemaFactory.createForClass(AnalyticsEvent);
AnalyticsEventSchema.index({ created_at: -1 });
AnalyticsEventSchema.index({ type: 1, created_at: -1 });
AnalyticsEventSchema.index({ organization_id: 1, created_at: -1 });
AnalyticsEventSchema.index({ user_id: 1 });
