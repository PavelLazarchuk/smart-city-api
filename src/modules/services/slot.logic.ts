import { randomUUID } from 'node:crypto';
import { type Types } from 'mongoose';

import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { shiftDateOnly, weekdayOfDateOnly } from '../../common/time/zone';
import { type BookingEntity } from '../bookings/bookings.repository';
import { type ServiceOptionInput, type SlotInput } from './dto/service.schemas';
import { type SlotBody, type SlotValue, type TimeEntry } from '../slots/schemas/slot.schema';
import {
    type RecurrentDate,
    type ServiceOption,
    WEEKDAYS,
    type WorkingHours,
} from './schemas/service.schema';

export type OptionTree = ServiceOption & { slots: SlotBody[] };

export type ServiceTree<T extends { options: ServiceOption[] }> = Omit<T, 'options'> & {
    options: OptionTree[];
};

export function growTrees<T extends { _id: Types.ObjectId; options: ServiceOption[] }>(
    services: T[],
    slots: (SlotBody & { service_id: Types.ObjectId; option_id: string })[],
): ServiceTree<T>[] {
    const byOption = new Map<string, SlotBody[]>();

    for (const {
        id,
        label,
        child_type: childType,
        value,
        service_id: serviceId,
        option_id: optionId,
    } of slots) {
        const key = `${serviceId.toHexString()}|${optionId}`;
        const bucket = byOption.get(key) ?? [];
        bucket.push({ id, label, child_type: childType, value });
        byOption.set(key, bucket);
    }

    return services.map((service) => ({
        ...service,
        options: (service.options ?? []).map((option) => ({
            ...option,
            slots: byOption.get(`${service._id.toHexString()}|${option.id}`) ?? [],
        })),
    }));
}

export function optionOf<T extends { id: string }>(service: { options: T[] }, optionId: string): T {
    const option = service.options.find((item) => item.id === optionId);

    if (!option) throw ApiError.notFound('OPTION_NOT_FOUND');

    return option;
}

export function slotOf(option: { slots: SlotBody[] }, slotId: string): SlotBody {
    const slot = option.slots.find((item) => item.id === slotId);

    if (!slot) throw ApiError.notFound('SLOT_NOT_FOUND');

    return slot;
}

export function slotFromInput(input: SlotInput): SlotBody {
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

export function optionFromInput(input: ServiceOptionInput): { option: ServiceOption; slots: SlotBody[] } {
    return {
        option: {
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
        },
        slots: (input.slots ?? []).map(slotFromInput),
    };
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

export type SlotWithBookings = Omit<SlotBody, 'value'> & {
    value: Omit<SlotValue, 'time'> & { time?: TimeEntryWithBookings[]; bookings?: BookingView[] };
};

/** Nothing is loaded for anyone else, so a public route cannot leak personal data even if `mask()` is forgotten. */
export function attachBookings<T extends { id: string; slots: SlotBody[] }>(
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
    from: string,
    horizonDays: number,
    context: RecurrenceContext = {},
): GeneratedDay[] {
    const byWeekday = new Map<number, RecurrentDate>();

    for (const entry of recurrent) byWeekday.set(WEEKDAYS.indexOf(entry.day), entry);

    const holidays = new Set(context.holidays ?? []);
    const blackouts = new Set(context.blackout_dates ?? []);
    const result: GeneratedDay[] = [];

    for (let i = 1; i <= horizonDays; i += 1) {
        const date = shiftDateOnly(from, i);
        const config = byWeekday.get(weekdayOfDateOnly(date));

        if (!config) continue;

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
    add_slots: SlotBody[];
    add_times: { slot_id: string; entries: TimeEntry[] }[];
    remove_times: { slot_id: string; times: string[] }[];
}

export function isEmptyPlan(plan: RecurrentSlotPlan): boolean {
    return plan.add_slots.length === 0 && plan.add_times.length === 0 && plan.remove_times.length === 0;
}

/** Returns additions and removals, not a rewritten `slots` array; times that hold bookings are never removed. */
export function planRecurrentDays(slots: SlotBody[], days: GeneratedDay[]): RecurrentSlotPlan {
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

export function isSlotExpired(slot: Pick<SlotBody, 'child_type' | 'value'>, today: string): boolean {
    if (slot.child_type !== 'date_time' && slot.child_type !== 'date') return false;

    return typeof slot.value.date === 'string' && slot.value.date < today;
}
