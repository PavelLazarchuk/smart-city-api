import { Injectable } from '@nestjs/common';

import { AppConfig } from '../common/config/app-config';
import { OutboxService } from '../common/outbox/outbox.service';
import { BookingsRepository } from '../modules/bookings/bookings.repository';
import { formatDateOnly } from '../modules/services/slot.logic';
import { UsersService } from '../modules/users/users.service';
import { JobRunner } from './job-runner';

export const BOOKING_REMINDERS_JOB = 'booking_reminders';

const BATCH = 200;

@Injectable()
export class BookingRemindersJob {
    constructor(
        private readonly bookings: BookingsRepository,
        private readonly users: UsersService,
        private readonly outbox: OutboxService,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(BOOKING_REMINDERS_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ date: string; reminders: number }> {
        const target = new Date(now.getTime() + this.config.bookings.reminderHours * 60 * 60 * 1000);
        const date = formatDateOnly(target);
        let reminders = 0;

        for (;;) {
            const due = await this.bookings.findDueReminders(date, BATCH);

            if (due.length === 0) break;

            const emails = await this.users.findEmailsByIds(
                due.map((booking) => booking.user_id.toHexString()),
            );

            for (const booking of due) {
                await this.outbox.enqueue(
                    'booking.reminder',
                    {
                        booking_id: booking.id,
                        service_id: booking.service_id.toHexString(),
                        organization_id: booking.organization_id.toHexString(),
                        option_id: booking.option_id,
                        slot_id: booking.slot_id,
                        date: booking.slot_date,
                        time: booking.slot_time,
                        user_id: booking.user_id.toHexString(),
                        status: booking.status,
                        service_label: booking.service_label,
                    },
                    {
                        organizationId: booking.organization_id,
                        internal: {
                            phone: booking.phone,
                            email: emails.get(booking.user_id.toHexString()) ?? null,
                        },
                    },
                );
            }

            reminders += await this.bookings.markReminded(
                due.map((booking) => booking.id),
                now,
            );
        }

        if (reminders > 0) this.outbox.poke();

        return { date, reminders };
    }
}
