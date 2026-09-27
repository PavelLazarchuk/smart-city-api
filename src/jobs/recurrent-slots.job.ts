import { Injectable } from '@nestjs/common';

import { AppConfig } from '../common/config/app-config';
import { dateOnlyIn, shiftDateOnly } from '../common/time/zone';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { RECURRENT_SERVICE_TYPES } from '../modules/services/schemas/service.schema';
import { ServicesService } from '../modules/services/services.service';
import {
    generateRecurrentDays,
    generateRecurrentRanges,
    growTrees,
    isEmptyPlan,
    isEmptyRangePlan,
    planRecurrentDays,
    planRecurrentRanges,
    type RecurrentRangePlan,
    type RecurrentSlotPlan,
} from '../modules/services/slot.logic';
import { type SlotOwner, SlotsRepository } from '../modules/slots/slots.repository';
import { JobRunner } from './job-runner';

export const RECURRENT_SLOTS_JOB = 'recurrent_slots';

/** The plan is applied as inserts and targeted `$push`/`$pull`, so a booking made while the job runs is not lost. */
@Injectable()
export class RecurrentSlotsJob {
    constructor(
        private readonly services: ServicesService,
        private readonly slots: SlotsRepository,
        private readonly organizations: OrganizationsService,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(RECURRENT_SLOTS_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ services_updated: number }> {
        const horizon = this.config.retention.recurrentHorizonDays;
        const [services, organizationHolidays, timezones] = await Promise.all([
            this.services.findWithRecurrentOptions(),
            this.organizations.holidays(),
            this.organizations.timezones(),
        ]);
        const trees = growTrees(
            services,
            await this.slots.findRecurringByServices(services.map((service) => service._id)),
        );
        const plans: (SlotOwner & { plan: RecurrentSlotPlan; ranges: RecurrentRangePlan })[] = [];

        for (const service of trees) {
            const organizationId = service.organization_id.toHexString();
            const holidays = [
                ...(service.holidays ?? []),
                ...(organizationHolidays.get(organizationId) ?? []),
            ];
            const today = dateOnlyIn(now, timezones.get(organizationId) ?? this.config.jobs.timezone);

            const context = {
                working_hours: service.working_hours,
                duration_minutes: service.duration_minutes,
                buffer_minutes: service.buffer_minutes,
                holidays,
                blackout_dates: service.blackout_dates,
            };
            const window = { from: today, to: shiftDateOnly(today, horizon) };

            for (const option of service.options) {
                if (!RECURRENT_SERVICE_TYPES.includes(option.service_type)) continue;

                const plan = planRecurrentDays(
                    option.slots,
                    option.recurrent_dates?.length
                        ? generateRecurrentDays(option.recurrent_dates, today, horizon, context)
                        : [],
                );
                const ranges = option.recurrent_ranges?.length
                    ? planRecurrentRanges(
                          option.slots,
                          generateRecurrentRanges(option.recurrent_ranges, today, horizon, context),
                          window,
                      )
                    : { add_slots: [], update_ranges: [], remove_slots: [] };

                if (!isEmptyPlan(plan) || !isEmptyRangePlan(ranges))
                    plans.push({
                        service_id: service._id,
                        organization_id: service.organization_id,
                        option_id: option.id,
                        plan,
                        ranges,
                    });
            }
        }

        await this.slots.applyRecurrentPlans(plans);

        return { services_updated: new Set(plans.map((entry) => entry.service_id.toHexString())).size };
    }
}
