import { randomUUID } from 'node:crypto';
import { type Types } from 'mongoose';

import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { type BookingEntity } from '../bookings/bookings.repository';
import { type ServiceOptionInput, type SlotInput } from './dto/service.schemas';
import {
    type RecurrentDate,
    type ServiceOption,
    type Slot,
    type SlotValue,
    type TimeEntry,
    WEEKDAYS,
    type WorkingHours,
} from './schemas/service.schema';

export function formatDateOnly(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

export function optionOf<T extends { options: ServiceOption[] }>(
    service: T,
    optionId: string,
): ServiceOption {
    const option = service.options.find((item) => item.id === optionId);

    if (!option) throw ApiError.notFound('OPTION_NOT_FOUND');

    return option;
}

export function slotOf(option: { slots: Slot[] }, slotId: string): Slot {
    const slot = option.slots.find((item) => item.id === slotId);

    if (!slot) throw ApiError.notFound('SLOT_NOT_FOUND');

    return slot;
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
                    })),
                },
            };
        case 'date':
            return {
                id,
                label: input.label ?? texts.defaults.dateSlotLabel,
                child_type: 'date',
                value: { date: input.value.date, limit: input.value.limit ?? null, booked_count: 0 },
            };
        case 'apply':
            return {
                id,
                label: input.label ?? texts.defaults.slotLabel,
                child_type: 'apply',
                value: { limit: input.value.limit ?? null, booked_count: 0 },
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
                      limit: entry.limit ?? null,
                  })),
        slots: (input.slots ?? []).map(slotFromInput),
    };
}

/**
 * Occupancy is copied by id. A renamed time finds no match and is kept while it still holds bookings, so an
 * edit can never strand one.
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

                        return oldEntry ? { ...entry, booked_count: oldEntry.booked_count } : entry;
                    });
                    const requested = new Set(incomingTimes.map((entry) => entry.time));
                    const booked = (old.value.time ?? []).filter(
                        (entry) => !requested.has(entry.time) && entry.booked_count > 0,
                    );

                    return { ...slot, value: { ...slot.value, time: [...kept, ...booked] } };
                }

                if (slot.child_type === 'date' || slot.child_type === 'apply') {
                    return { ...slot, value: { ...slot.value, booked_count: old.value.booked_count ?? 0 } };
                }

                return slot;
            }),
        };
    });
}

export interface BookingView {
    id: string;
    user_id: Types.ObjectId;
    person: string;
    phone: string;
    info: string;
    status: string;
    created_at: Date;
}

export type TimeEntryWithBookings = TimeEntry & { bookings?: BookingView[] };

export type SlotWithBookings = Omit<Slot, 'value'> & {
    value: Omit<SlotValue, 'time'> & { time?: TimeEntryWithBookings[]; bookings?: BookingView[] };
};

/** Nothing is loaded for anyone else, so a public route cannot leak personal data even if `mask()` is forgotten. */
export function attachBookings<T extends { id: string; slots: Slot[] }>(
    options: T[],
    bookings: BookingEntity[],
): (Omit<T, 'slots'> & { slots: SlotWithBookings[] })[] {
    const bySlot = new Map<string, BookingView[]>();

    for (const booking of bookings) {
        const key = `${booking.option_id}|${booking.slot_id}|${booking.slot_time ?? ''}`;
        const view: BookingView = {
            id: booking.id,
            user_id: booking.user_id,
            person: booking.person,
            phone: booking.phone,
            info: booking.info,
            status: booking.status,
            created_at: booking.created_at,
        };
        bySlot.set(key, [...(bySlot.get(key) ?? []), view]);
    }

    return options.map((option) => ({
        ...option,
        slots: option.slots.map((slot): SlotWithBookings => {
            if (slot.child_type === 'date_time') {
                return {
                    ...slot,
                    value: {
                        ...slot.value,
                        time: (slot.value.time ?? []).map((entry) => ({
                            ...entry,
                            bookings: bySlot.get(`${option.id}|${slot.id}|${entry.time}`) ?? [],
                        })),
                    },
                };
            }

            if (slot.child_type === 'date' || slot.child_type === 'apply') {
                return {
                    ...slot,
                    value: { ...slot.value, bookings: bySlot.get(`${option.id}|${slot.id}|`) ?? [] },
                };
            }

            return slot;
        }),
    }));
}

export interface GeneratedDay {
    date: string;
    time: { time: string; limit: number | null }[];
}

export interface RecurrenceContext {
    working_hours?: WorkingHours[];
    duration_minutes?: number | null;
    buffer_minutes?: number | null;
    holidays?: string[];
    blackout_dates?: string[];
}

export function minutesOf(time: string): number {
    const [hours = 0, minutes = 0] = time.split(':').map(Number);

    return hours * 60 + minutes;
}

export function timeOf(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function timesFromWorkingHours(
    hours: WorkingHours[],
    day: (typeof WEEKDAYS)[number],
    durationMinutes: number,
    bufferMinutes: number,
    limit: number | null,
): { time: string; limit: number | null }[] {
    const step = durationMinutes + bufferMinutes;
    const starts = new Set<number>();

    for (const interval of hours) {
        if (interval.day !== day) continue;

        const open = minutesOf(interval.from);
        const close = minutesOf(interval.to);

        for (let start = open; start + durationMinutes <= close; start += step) starts.add(start);
    }

    return [...starts].sort((a, b) => a - b).map((start) => ({ time: timeOf(start), limit }));
}

export function generateRecurrentDays(
    recurrent: RecurrentDate[],
    from: Date,
    horizonDays: number,
    context: RecurrenceContext = {},
): GeneratedDay[] {
    const byWeekday = new Map<number, RecurrentDate>();

    for (const entry of recurrent) byWeekday.set(WEEKDAYS.indexOf(entry.day), entry);

    const holidays = new Set(context.holidays ?? []);
    const blackouts = new Set(context.blackout_dates ?? []);
    const result: GeneratedDay[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());

    for (let i = 1; i <= horizonDays; i += 1) {
        cursor.setDate(cursor.getDate() + 1);
        const config = byWeekday.get(cursor.getDay());

        if (!config) continue;

        const date = formatDateOnly(cursor);

        if (blackouts.has(date) || holidays.has(date.slice(5))) continue;

        const explicit = config.time.map((time) => ({ time: time.time, limit: time.limit }));
        const generated =
            explicit.length === 0 && context.duration_minutes && context.working_hours?.length
                ? timesFromWorkingHours(
                      context.working_hours,
                      config.day,
                      context.duration_minutes,
                      context.buffer_minutes ?? 0,
                      config.limit ?? null,
                  )
                : explicit;

        if (generated.length === 0) continue;

        result.push({ date, time: generated });
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

/** Returns additions and removals, not a rewritten `slots` array; times that hold bookings are never removed. */
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
                    })),
                },
            });
            continue;
        }

        const entries = slot.value.time ?? [];
        const configured = new Set(day.time.map((time) => time.time));
        const added = day.time
            .filter((time) => !entries.some((entry) => entry.time === time.time))
            .map((time): TimeEntry => ({ time: time.time, limit: time.limit, booked_count: 0 }));

        if (added.length > 0) plan.add_times.push({ slot_id: slot.id, entries: added });

        const stale = entries
            .filter((entry) => !configured.has(entry.time) && entry.booked_count === 0)
            .map((entry) => entry.time);

        if (stale.length > 0) plan.remove_times.push({ slot_id: slot.id, times: stale });
    }

    return plan;
}

export function isSlotExpired(slot: Slot, today: string): boolean {
    if (slot.child_type !== 'date_time' && slot.child_type !== 'date') return false;

    return typeof slot.value.date === 'string' && slot.value.date < today;
}
