import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

export const JOB_RUN_STATUSES = ['ok', 'failed'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/**
 * One document per job; `_id` is the job name. Besides the lease it carries the outcome of the last
 * run, so a job that fails quietly night after night is visible in the database and over
 * `GET /health/jobs` rather than only in a log stream nobody is tailing.
 */
@Schema({ collection: 'job_locks', versionKey: false, minimize: false })
export class JobLock {
    @Prop({ type: String, required: true })
    _id!: string;

    @Prop({ type: Date, required: true })
    locked_until!: Date;

    @Prop({ type: String, required: true })
    holder!: string;

    /** When the lease was last taken, i.e. when the job last actually started. */
    @Prop({ type: Date })
    last_started_at?: Date;

    @Prop({ type: Date })
    last_finished_at?: Date;

    /** The last run that finished; a run skipped for a held lease leaves it untouched. */
    @Prop({ type: String, enum: JOB_RUN_STATUSES })
    last_status?: JobRunStatus;

    @Prop({ type: Number })
    last_duration_ms?: number;

    /** When the job last finished without throwing; what an alert on staleness watches. */
    @Prop({ type: Date })
    last_success_at?: Date;

    /** Truncated failure message, cleared by the next success. It can quote a dependency's host,
     * so it is served to a super-admin only. */
    @Prop({ type: String })
    last_error?: string;

    @Prop({ type: Number, required: true, default: 0 })
    consecutive_failures!: number;
}

export type JobLockDocument = HydratedDocument<JobLock>;
export const JobLockSchema = SchemaFactory.createForClass(JobLock);
