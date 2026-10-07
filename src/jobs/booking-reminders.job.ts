import { Injectable } from '@nestjs/common';

import { SettingsService } from '../common/settings/settings.service';
import { OutboxService } from '../common/outbox/outbox.service';
import { BookingsRepository } from '../modules/bookings/bookings.repository';
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
        private readonly settings: SettingsService,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(BOOKING_REMINDERS_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ until: string; reminders: number }> {
        const until = new Date(now.getTime() + this.settings.get('bookings.reminder_hours') * 60 * 60 * 1000);
        let reminders = 0;

        for (;;) {
            const due = await this.bookings.findDueReminders(now, until, BATCH);

            if (due.length === 0) break;

            const userIds = due.map((booking) => booking.user_id.toHexString());
            const emails = await this.users.findEmailsByIds(userIds);
            const muted = await this.users.findWithoutReminders(userIds);

            for (const booking of due) {
                const callback = booking.child_type === 'callback';
                await this.outbox.enqueue(
                    callback ? 'booking.callback_due' : 'booking.reminder',
                    {
                        booking_id: booking.id,
                        service_id: booking.service_id.toHexString(),
                        organization_id: booking.organization_id.toHexString(),
                        option_id: booking.option_id,
                        slot_id: booking.slot_id,
                        date: booking.slot_date,
                        time: booking.slot_time,
                        end_time: booking.slot_end ?? null,
                        user_id: booking.user_id.toHexString(),
                        status: booking.status,
                        service_label: booking.service_label,
                    },
                    {
                        organizationId: booking.organization_id,
                        internal: callback
                            ? { phone: booking.phone, person: booking.person }
                            : {
                                  phone: booking.phone,
                                  email: emails.get(booking.user_id.toHexString()) ?? null,
                                  checkin_code: booking.checkin_code ?? null,
                                  ...(muted.has(booking.user_id.toHexString()) ? { reminders: false } : {}),
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

        return { until: until.toISOString(), reminders };
    }
}
