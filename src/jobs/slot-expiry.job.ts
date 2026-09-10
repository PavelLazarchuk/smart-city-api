import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../common/database/transaction-runner';
import { ArchivesService } from '../modules/archives/archives.service';
import { ServicesService } from '../modules/services/services.service';
import { UsersService } from '../modules/users/users.service';
import { collectBookingIds, formatDateOnly, isSlotExpired } from '../modules/services/slot.logic';
import { JobRunner } from './job-runner';

export const SLOT_EXPIRY_JOB = 'slot_expiry';

/** Archives expired dated slots and removes them from services and users, transactionally. */
@Injectable()
export class SlotExpiryJob {
    constructor(
        private readonly services: ServicesService,
        private readonly archives: ArchivesService,
        private readonly users: UsersService,
        private readonly tx: TransactionRunner,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(SLOT_EXPIRY_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ services_updated: number; slots_archived: number }> {
        const today = formatDateOnly(now);
        const candidates = await this.services.findWithDatedSlots();
        let servicesUpdated = 0;
        let slotsArchived = 0;

        for (const candidate of candidates) {
            const id = candidate._id.toHexString();
            const archived = await this.tx.run(async (ctx) => {
                const service = await this.services.findForUpdate(id, ctx.session);

                if (!service) return 0;

                const expired = service.options.flatMap((option) =>
                    option.slots
                        .filter((slot) => isSlotExpired(slot, today))
                        .map((slot) => ({ option, slot })),
                );

                if (expired.length === 0) return 0;

                for (const { option, slot } of expired) {
                    await this.archives.createSnapshot(
                        {
                            organization_id: service.organization_id,
                            service_id: service._id,
                            type: 'service',
                            data: { service_id: id, option_id: option.id, slot },
                        },
                        ctx.session,
                    );
                }

                const byOption = new Map<string, string[]>();

                for (const { option, slot } of expired) {
                    byOption.set(option.id, [...(byOption.get(option.id) ?? []), slot.id]);
                }

                for (const [optionId, slotIds] of byOption) {
                    await this.services.pullSlots(id, optionId, slotIds, ctx.session);
                }

                const bookingIds = collectBookingIds(
                    expired.map(({ option, slot }) => ({ ...option, slots: [slot] })),
                );
                await this.users.removeBookingRefsByIds(bookingIds, ctx);

                return expired.length;
            });

            if (archived > 0) {
                servicesUpdated += 1;
                slotsArchived += archived;
            }
        }

        return { services_updated: servicesUpdated, slots_archived: slotsArchived };
    }
}
