import { Injectable } from '@nestjs/common';

import { type DispatchSummary, OutboxService } from '../common/outbox/outbox.service';
import { JobRunner } from './job-runner';

export const OUTBOX_DISPATCH_JOB = 'outbox_dispatch';

@Injectable()
export class OutboxDispatchJob {
    constructor(
        private readonly outbox: OutboxService,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(OUTBOX_DISPATCH_JOB, () => this.execute(now));
    }

    execute(now: Date): Promise<DispatchSummary> {
        return this.outbox.dispatch(now);
    }
}
