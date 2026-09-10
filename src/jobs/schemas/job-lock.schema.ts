import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

/** One document per job; `_id` is the job name. */
@Schema({ collection: 'job_locks', versionKey: false, minimize: false })
export class JobLock {
    @Prop({ type: String, required: true })
    _id!: string;

    @Prop({ type: Date, required: true })
    locked_until!: Date;

    @Prop({ type: String, required: true })
    holder!: string;
}

export type JobLockDocument = HydratedDocument<JobLock>;
export const JobLockSchema = SchemaFactory.createForClass(JobLock);
