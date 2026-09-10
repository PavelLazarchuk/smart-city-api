import { Injectable } from '@nestjs/common';

import { AppConfig } from '../common/config/app-config';
import { ServicesService } from '../modules/services/services.service';
import { generateRecurrentDays, isEmptyPlan, planRecurrentDays } from '../modules/services/slot.logic';
import { type RecurrentSlotPlan } from '../modules/services/slot.logic';
import { JobRunner } from './job-runner';

export const RECURRENT_SLOTS_JOB = 'recurrent_slots';

/**
 * Generates `date_time` slots for recurrent options over the configured horizon. The plan is applied
 * as targeted `$push`/`$pull` in one `bulkWrite`, so a booking made while the job runs is not lost.
 */
@Injectable()
export class RecurrentSlotsJob {
    constructor(
        private readonly services: ServicesService,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(RECURRENT_SLOTS_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ services_updated: number }> {
        const horizon = this.config.retention.recurrentHorizonDays;
        const services = await this.services.findWithRecurrentOptions();
        const plans: { id: string; option_id: string; plan: RecurrentSlotPlan }[] = [];

        for (const service of services) {
            for (const option of service.options) {
                if (option.service_type !== 'service_apply' || !option.recurrent_dates?.length) continue;

                const days = generateRecurrentDays(option.recurrent_dates, now, horizon);
                const plan = planRecurrentDays(option.slots, days);

                if (!isEmptyPlan(plan))
                    plans.push({ id: service._id.toHexString(), option_id: option.id, plan });
            }
        }

        await this.services.applyRecurrentPlans(plans);

        return { services_updated: new Set(plans.map((entry) => entry.id)).size };
    }
}
