import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../common/database/transaction-runner';
import { BookingsRepository } from '../modules/bookings/bookings.repository';
import { SlotsRepository } from '../modules/slots/slots.repository';
import { JobRunner } from './job-runner';

export const STALE_BOOKINGS_JOB = 'stale_bookings';

const BATCH = 200;

/** Drops bookings whose slot is gone. Finished rows are statistics, not reservations, and wait for their TTL. */
@Injectable()
export class StaleBookingsJob {
    constructor(
        private readonly bookings: BookingsRepository,
        private readonly slots: SlotsRepository,
        private readonly tx: TransactionRunner,
        private readonly runner: JobRunner,
    ) {}

    run(): Promise<unknown> {
        return this.runner.run(STALE_BOOKINGS_JOB, () => this.execute());
    }

    async execute(): Promise<{ bookings_removed: number }> {
        const live = await this.liveSlots();
        let stale: string[] = [];
        let removed = 0;

        for await (const booking of this.bookings.iterateActive()) {
            const key = this.keyOf(
                booking.service_id.toHexString(),
                booking.option_id,
                booking.slot_id,
                booking.slot_time,
            );

            if (live.has(key)) continue;

            stale.push(booking.id);

            if (stale.length < BATCH) continue;

            removed += await this.remove(stale);
            stale = [];
        }

        removed += await this.remove(stale);

        return { bookings_removed: removed };
    }

    private async remove(ids: string[]): Promise<number> {
        if (ids.length === 0) return 0;

        return this.tx.run((ctx) => this.bookings.deleteByIds(ids, ctx.session));
    }

    private async liveSlots(): Promise<Set<string>> {
        const live = new Set<string>();

        for await (const slot of this.slots.iterateKeys()) {
            const serviceId = slot.service_id.toHexString();
            const times = slot.value?.time ?? [];

            if (times.length === 0) {
                live.add(this.keyOf(serviceId, slot.option_id, slot.id, null));
                continue;
            }

            for (const entry of times) live.add(this.keyOf(serviceId, slot.option_id, slot.id, entry.time));
        }

        return live;
    }

    private keyOf(serviceId: string, optionId: string, slotId: string, time: string | null): string {
        return `${serviceId}|${optionId}|${slotId}|${time ?? ''}`;
    }
}
