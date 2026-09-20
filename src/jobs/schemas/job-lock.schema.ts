import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

export const JOB_RUN_STATUSES = ['ok', 'failed'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/** `_id` is the job name. The last outcome lives here so a nightly failure is visible outside the logs. */
@Schema({ collection: 'job_locks', versionKey: false, minimize: false })
export class JobLock {
    @Prop({ type: String, required: true })
    _id!: string;

    @Prop({ type: Date, required: true })
    locked_until!: Date;

    @Prop({ type: String, required: true })
    holder!: string;

    @Prop({ type: Date })
    last_started_at?: Date;

    @Prop({ type: Date })
    last_finished_at?: Date;

    /** The last run that finished; a run skipped for a held lease leaves it untouched. */
    @Prop({ type: String, enum: JOB_RUN_STATUSES })
    last_status?: JobRunStatus;

    @Prop({ type: Number })
    last_duration_ms?: number;

    @Prop({ type: Date })
    last_success_at?: Date;

    /** Can quote a dependency's host, so it is served to a super-admin only. */
    @Prop({ type: String })
    last_error?: string;

    @Prop({ type: Number, required: true, default: 0 })
    consecutive_failures!: number;
}

export type JobLockDocument = HydratedDocument<JobLock>;
export const JobLockSchema = SchemaFactory.createForClass(JobLock);
