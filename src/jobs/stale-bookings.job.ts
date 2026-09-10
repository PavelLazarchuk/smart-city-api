import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../common/database/transaction-runner';
import { ServicesService } from '../modules/services/services.service';
import { collectBookingIds } from '../modules/services/slot.logic';
import { UsersService } from '../modules/users/users.service';
import { JobRunner } from './job-runner';

export const STALE_BOOKINGS_JOB = 'stale_bookings';

/**
 * Drops a user's booking references whose underlying slot no longer exists. Both sides are read with
 * a booking-ids-only projection and stale references removed with a targeted `$pull`, never a rewrite.
 */
@Injectable()
export class StaleBookingsJob {
    constructor(
        private readonly users: UsersService,
        private readonly services: ServicesService,
        private readonly tx: TransactionRunner,
        private readonly runner: JobRunner,
    ) {}

    run(): Promise<unknown> {
        return this.runner.run(STALE_BOOKINGS_JOB, () => this.execute());
    }

    async execute(): Promise<{ users_updated: number; references_removed: number }> {
        const services = await this.services.findAllBookingIds();
        const liveBookingIds = new Set(services.flatMap((service) => collectBookingIds(service.options)));
        let usersUpdated = 0;
        let removed = 0;

        for await (const user of this.users.iterateUsersWithBookings()) {
            const stale = user.bookings.filter((booking) => !liveBookingIds.has(booking.id)).map((b) => b.id);

            if (stale.length === 0) continue;

            await this.tx.run((ctx) => this.users.removeBookingRefsByIds(stale, ctx));
            usersUpdated += 1;
            removed += stale.length;
        }

        return { users_updated: usersUpdated, references_removed: removed };
    }
}
