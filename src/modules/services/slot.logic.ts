import { randomUUID } from 'node:crypto';

import { texts } from '../../common/i18n/messages';
import { type ServiceOptionInput, type SlotInput } from './dto/service.schemas';
import {
    type Booking,
    type RecurrentDate,
    type ServiceOption,
    type Slot,
    type TimeEntry,
    WEEKDAYS,
} from './schemas/service.schema';

export function formatDateOnly(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

export function slotFromInput(input: SlotInput): Slot {
    const id = input.id ?? randomUUID();
    switch (input.child_type) {
        case 'date_time':
            return {
                id,
                label: input.label ?? texts.defaults.slotLabel,
                child_type: 'date_time',
                value: {
                    date: input.value.date,
                    time: input.value.time.map((entry): TimeEntry => ({
                        time: entry.time,
                        limit: entry.limit ?? null,
                        booked_count: 0,
                        bookings: [],
                    })),
                },
            };
        case 'date':
            return {
                id,
                label: input.label ?? texts.defaults.dateSlotLabel,
                child_type: 'date',
                value: {
                    date: input.value.date,
                    limit: input.value.limit ?? null,
                    booked_count: 0,
                    bookings: [],
                },
            };
        case 'apply':
            return {
                id,
                label: input.label ?? texts.defaults.slotLabel,
                child_type: 'apply',
                value: { limit: input.value.limit ?? null, booked_count: 0, bookings: [] },
            };
        default:
            return {
                id,
                label: input.label ?? texts.defaults.slotLabel,
                child_type: input.child_type,
                value: {
                    description: input.value.description,
                    link: input.value.link,
                    price: input.value.price,
                },
            };
    }
}

export function optionFromInput(input: ServiceOptionInput): ServiceOption {
    return {
        id: input.id ?? randomUUID(),
        label: input.label ?? texts.defaults.optionLabel,
        service_type: input.service_type ?? 'service_apply',
        enabled: input.enabled ?? true,
        recurrent_dates:
            input.recurrent_dates === null || input.recurrent_dates === undefined
                ? undefined
                : input.recurrent_dates.map((entry) => ({
                      day: entry.day,
                      time: entry.time.map((time) => ({ time: time.time, limit: time.limit ?? null })),
                  })),
        slots: (input.slots ?? []).map(slotFromInput),
    };
}

/**
 * When an admin replaces `options`, existing bookings must survive: counters and booking lists are
 * copied from the stored option/slot/time by id. Time entries match on their `time` string, so a
 * renamed "10:00" finds no match and is kept alongside the new one while it still holds bookings —
 * the same rule as `planRecurrentDays`, so an edit can never strand a booking.
 */
export function mergeBookings(existing: ServiceOption[], incoming: ServiceOption[]): ServiceOption[] {
    const existingOptions = new Map(existing.map((option) => [option.id, option]));

    return incoming.map((option) => {
        const previous = existingOptions.get(option.id);

        if (!previous) return option;

        const previousSlots = new Map(previous.slots.map((slot) => [slot.id, slot]));

        return {
            ...option,
            slots: option.slots.map((slot) => {
                const old = previousSlots.get(slot.id);

                if (!old || old.child_type !== slot.child_type) return slot;

                if (slot.child_type === 'date_time') {
                    const oldTimes = new Map((old.value.time ?? []).map((entry) => [entry.time, entry]));
                    const incomingTimes = slot.value.time ?? [];
                    const kept = incomingTimes.map((entry) => {
                        const oldEntry = oldTimes.get(entry.time);

                        return oldEntry
                            ? { ...entry, booked_count: oldEntry.booked_count, bookings: oldEntry.bookings }
                            : entry;
                    });
                    const requested = new Set(incomingTimes.map((entry) => entry.time));
                    const booked = (old.value.time ?? []).filter(
                        (entry) => !requested.has(entry.time) && entry.bookings.length > 0,
                    );

                    return { ...slot, value: { ...slot.value, time: [...kept, ...booked] } };
                }

                if (slot.child_type === 'date' || slot.child_type === 'apply') {
                    return {
                        ...slot,
                        value: {
                            ...slot.value,
                            booked_count: old.value.booked_count ?? 0,
                            bookings: old.value.bookings ?? [],
                        },
                    };
                }

                return slot;
            }),
        };
    });
}

export function collectBookingIds(options: ServiceOption[]): string[] {
    const ids: string[] = [];

    for (const option of options) {
        for (const slot of option.slots) {
            for (const booking of slot.value.bookings ?? []) ids.push(booking.id);

            for (const entry of slot.value.time ?? [])
                for (const booking of entry.bookings ?? []) ids.push(booking.id);
        }
    }

    return ids;
}

export function findBookingsOfUser(
    options: ServiceOption[],
    userId: string,
): { option_id: string; slot_id: string; time?: string; booking: Booking }[] {
    const found: { option_id: string; slot_id: string; time?: string; booking: Booking }[] = [];

    for (const option of options) {
        for (const slot of option.slots) {
            for (const booking of slot.value.bookings ?? []) {
                if (booking.user_id.toHexString() === userId)
                    found.push({ option_id: option.id, slot_id: slot.id, booking });
            }

            for (const entry of slot.value.time ?? []) {
                for (const booking of entry.bookings) {
                    if (booking.user_id.toHexString() === userId) {
                        found.push({ option_id: option.id, slot_id: slot.id, time: entry.time, booking });
                    }
                }
            }
        }
    }

    return found;
}

export interface GeneratedDay {
    date: string;
    time: { time: string; limit: number | null }[];
}

export function generateRecurrentDays(
    recurrent: RecurrentDate[],
    from: Date,
    horizonDays: number,
): GeneratedDay[] {
    const byWeekday = new Map<number, RecurrentDate>();

    for (const entry of recurrent) byWeekday.set(WEEKDAYS.indexOf(entry.day), entry);

    const result: GeneratedDay[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());

    for (let i = 1; i <= horizonDays; i += 1) {
        cursor.setDate(cursor.getDate() + 1);
        const config = byWeekday.get(cursor.getDay());

        if (!config) continue;

        result.push({
            date: formatDateOnly(cursor),
            time: config.time.map((time) => ({ time: time.time, limit: time.limit })),
        });
    }

    return result;
}

export interface RecurrentSlotPlan {
    add_slots: Slot[];
    add_times: { slot_id: string; entries: TimeEntry[] }[];
    /** Times no longer configured on an existing dated slot; only unbooked ones are dropped. */
    remove_times: { slot_id: string; times: string[] }[];
}

export function isEmptyPlan(plan: RecurrentSlotPlan): boolean {
    return plan.add_slots.length === 0 && plan.add_times.length === 0 && plan.remove_times.length === 0;
}

/**
 * Diffs the generated days against the option's slots and returns additions and removals rather than a
 * rewritten `slots` array, so the job's `$push`/`$pull` never overwrites a booking made in between.
 * Times that still hold bookings are never removed — that would strand the booking.
 */
export function planRecurrentDays(slots: Slot[], days: GeneratedDay[]): RecurrentSlotPlan {
    const plan: RecurrentSlotPlan = { add_slots: [], add_times: [], remove_times: [] };

    for (const day of days) {
        const slot = slots.find((item) => item.child_type === 'date_time' && item.value.date === day.date);

        if (!slot) {
            plan.add_slots.push({
                id: randomUUID(),
                label: texts.defaults.dateSlotLabel,
                child_type: 'date_time',
                value: {
                    date: day.date,
                    time: day.time.map((time): TimeEntry => ({
                        time: time.time,
                        limit: time.limit,
                        booked_count: 0,
                        bookings: [],
                    })),
                },
            });
            continue;
        }

        const entries = slot.value.time ?? [];
        const configured = new Set(day.time.map((time) => time.time));
        const added = day.time
            .filter((time) => !entries.some((entry) => entry.time === time.time))
            .map((time): TimeEntry => ({
                time: time.time,
                limit: time.limit,
                booked_count: 0,
                bookings: [],
            }));

        if (added.length > 0) plan.add_times.push({ slot_id: slot.id, entries: added });

        const stale = entries
            .filter((entry) => !configured.has(entry.time) && entry.bookings.length === 0)
            .map((entry) => entry.time);

        if (stale.length > 0) plan.remove_times.push({ slot_id: slot.id, times: stale });
    }

    return plan;
}

export function isSlotExpired(slot: Slot, today: string): boolean {
    if (slot.child_type !== 'date_time' && slot.child_type !== 'date') return false;

    return typeof slot.value.date === 'string' && slot.value.date < today;
}
