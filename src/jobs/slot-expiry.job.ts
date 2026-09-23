import { Injectable } from '@nestjs/common';

import { AppConfig } from '../common/config/app-config';
import { TransactionRunner } from '../common/database/transaction-runner';
import { dateOnlyIn, shiftDateOnly } from '../common/time/zone';
import { ArchivesService } from '../modules/archives/archives.service';
import { BookingsRepository } from '../modules/bookings/bookings.repository';
import { WaitlistRepository } from '../modules/bookings/waitlist.repository';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { isSlotExpired } from '../modules/services/slot.logic';
import { type SlotEntity, SlotsRepository } from '../modules/slots/slots.repository';
import { JobRunner } from './job-runner';

export const SLOT_EXPIRY_JOB = 'slot_expiry';

@Injectable()
export class SlotExpiryJob {
    constructor(
        private readonly slots: SlotsRepository,
        private readonly organizations: OrganizationsService,
        private readonly config: AppConfig,
        private readonly archives: ArchivesService,
        private readonly bookings: BookingsRepository,
        private readonly waitlist: WaitlistRepository,
        private readonly tx: TransactionRunner,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(SLOT_EXPIRY_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ services_updated: number; slots_archived: number }> {
        const timezones = await this.organizations.timezones();
        const todayOf = (slot: SlotEntity): string =>
            dateOnlyIn(now, timezones.get(slot.organization_id.toHexString()) ?? this.config.jobs.timezone);
        // No zone runs more than a day ahead of UTC, so this bound still covers every organization's past.
        const candidates = await this.slots.findDatedBefore(shiftDateOnly(dateOnlyIn(now, 'UTC'), 1));
        const byService = new Map<string, SlotEntity[]>();

        for (const slot of candidates) {
            if (!isSlotExpired(slot, todayOf(slot))) continue;

            const key = slot.service_id.toHexString();
            byService.set(key, [...(byService.get(key) ?? []), slot]);
        }

        let servicesUpdated = 0;
        let slotsArchived = 0;

        for (const [serviceId, expired] of byService) {
            const archived = await this.tx.run(async (ctx) => {
                let count = 0;

                for (const candidate of expired) {
                    const slot = await this.slots.findById(candidate._id.toHexString(), ctx.session);

                    if (!slot || !isSlotExpired(slot, todayOf(slot))) continue;

                    const optionId = slot.option_id;
                    const bookings = await this.bookings.findBySlots(
                        serviceId,
                        optionId,
                        [slot.id],
                        ctx.session,
                    );
                    await this.archives.createSnapshot(
                        {
                            organization_id: slot.organization_id,
                            service_id: slot.service_id,
                            type: 'service',
                            data: {
                                service_id: serviceId,
                                option_id: optionId,
                                slot: {
                                    id: slot.id,
                                    label: slot.label,
                                    child_type: slot.child_type,
                                    value: slot.value,
                                },
                                bookings,
                            },
                        },
                        ctx.session,
                    );
                    await this.slots.deleteSlots(serviceId, optionId, [slot.id], ctx.session);
                    await this.bookings.deleteBySlots(serviceId, optionId, [slot.id], ctx.session, true);
                    await this.waitlist.deleteBySlots(serviceId, optionId, [slot.id], ctx.session);
                    count += 1;
                }

                return count;
            });

            if (archived > 0) {
                servicesUpdated += 1;
                slotsArchived += archived;
            }
        }

        return { services_updated: servicesUpdated, slots_archived: slotsArchived };
    }
}
