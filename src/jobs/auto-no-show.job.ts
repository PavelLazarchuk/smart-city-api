import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { noShowCutoffs } from '../modules/bookings/booking-policy';
import { BookingsRepository } from '../modules/bookings/bookings.repository';
import { BookingsService } from '../modules/bookings/bookings.service';
import { ServicesService } from '../modules/services/services.service';
import { JobRunner } from './job-runner';

export const AUTO_NO_SHOW_JOB = 'auto_no_show';

const BATCH = 200;

@Injectable()
export class AutoNoShowJob {
    constructor(
        private readonly services: ServicesService,
        private readonly bookings: BookingsRepository,
        private readonly lifecycle: BookingsService,
        private readonly runner: JobRunner,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(AutoNoShowJob.name);
    }

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(AUTO_NO_SHOW_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ services: number; marked: number; failed: number }> {
        const policies = await this.services.findAutoNoShowPolicies();
        let marked = 0;
        let failed = 0;

        for (const { id, minutes } of policies) {
            const { timedBefore, untimedBefore } = noShowCutoffs(minutes, now);

            for (;;) {
                const due = await this.bookings.findOverdue(id, timedBefore, untimedBefore, BATCH);
                let moved = 0;

                for (const bookingId of due) {
                    try {
                        if (await this.lifecycle.markNoShow(bookingId)) moved += 1;
                    } catch (error) {
                        failed += 1;
                        this.logger.error({ err: error, booking_id: bookingId }, 'auto no-show failed');
                    }
                }

                marked += moved;

                if (due.length < BATCH || moved === 0) break;
            }
        }

        return { services: policies.length, marked, failed };
    }
}
