import { randomUUID } from 'node:crypto';
import { type Types } from 'mongoose';

import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { shiftDateOnly, weekdayOfDateOnly } from '../../common/time/zone';
import { type BookingEntity } from '../bookings/bookings.repository';
import { type RecurrentRangeInput, type ServiceOptionInput, type SlotInput } from './dto/service.schemas';
import { type SlotBody, type SlotValue, type TimeEntry } from '../slots/schemas/slot.schema';
import {
    ALLOWED_SLOT_TYPES,
    BOOKABLE_SLOT_TYPES,
    DATED_SLOT_TYPES,
    type RecurrentDate,
    type RecurrentRange,
    type ServiceOption,
    type ServiceType,
    type SlotType,
    TIMED_SLOT_TYPES,
    type Weekday,
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

export const DEFAULT_RANGE_STEP_MINUTES = 30;

export interface SlotContext {
    working_hours?: WorkingHours[];
    duration_minutes?: number | null;
}

type RangeInput = Extract<SlotInput, { child_type: 'time_range' }>['value'];

export interface Range {
    from: string;
    to: string;
    step_minutes: number;
    min_minutes: number;
    max_minutes: number | null;
}

function isValidRange(range: Range): boolean {
    const span = minutesOf(range.to) - minutesOf(range.from);

    return (
        span > 0 &&
        range.min_minutes <= span &&
        (range.max_minutes === null || range.max_minutes >= range.min_minutes)
    );
}

export function assertRange(range: Range): void {
    if (!isValidRange(range)) throw ApiError.unprocessable('SLOT_RANGE_INVALID');
}

interface RangeSpec {
    from?: string;
    to?: string;
    step_minutes?: number;
    min_minutes?: number;
    max_minutes?: number | null;
}

function rangeFor(spec: RangeSpec, day: Weekday, context: SlotContext): Range | null {
    let { from, to } = spec;

    if (from === undefined || to === undefined) {
        const hours = (context.working_hours ?? []).filter((entry) => entry.day === day);

        if (hours.length === 0) return null;

        from = hours.map((entry) => entry.from).sort()[0]!;
        to = hours
            .map((entry) => entry.to)
            .sort()
            .at(-1)!;
    }

    const step = spec.step_minutes ?? context.duration_minutes ?? DEFAULT_RANGE_STEP_MINUTES;

    return {
        from,
        to,
        step_minutes: step,
        min_minutes: spec.min_minutes ?? step,
        max_minutes: spec.max_minutes ?? null,
    };
}

function rangeFromInput(value: RangeInput, context: SlotContext): Range {
    const range = rangeFor(value, WEEKDAYS[weekdayOfDateOnly(value.date)]!, context);

    if (!range) throw ApiError.unprocessable('SLOT_RANGE_REQUIRED');

    assertRange(range);

    return range;
}

const INFO_LABELS: Record<'pickup' | 'courier' | 'paycard', string> = {
    pickup: texts.defaults.pickupSlotLabel,
    courier: texts.defaults.courierSlotLabel,
    paycard: texts.defaults.slotLabel,
};

export function slotFromInput(input: SlotInput, context: SlotContext = {}): SlotBody {
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
        case 'time_range':
            return {
                id,
                label: input.label ?? texts.defaults.rangeSlotLabel,
                child_type: 'time_range',
                value: { date: input.value.date, ...rangeFromInput(input.value, context), booked_count: 0 },
            };
        case 'callback':
            return {
                id,
                label: input.label ?? texts.defaults.callbackSlotLabel,
                child_type: 'callback',
                value: {
                    date: input.value.date,
                    time: input.value.time.map((entry): TimeEntry => ({
                        time: entry.time,
                        to: entry.to,
                        limit: entry.limit ?? null,
                        booked_count: 0,
                    })),
                },
            };
        default:
            return {
                id,
                label: input.label ?? INFO_LABELS[input.child_type],
                child_type: input.child_type,
                value: {
                    description: input.value.description,
                    link: input.value.link,
                    price: input.value.price,
                },
            };
    }
}

export function assertSlotTypesAllowed(
    serviceType: ServiceType,
    slots: Pick<SlotBody, 'child_type'>[],
): void {
    const allowed = ALLOWED_SLOT_TYPES[serviceType];
    const refused = [...new Set(slots.map((slot) => slot.child_type))].filter(
        (type) => !allowed.includes(type),
    );

    if (refused.length > 0)
        throw ApiError.unprocessable(
            'SLOT_TYPE_NOT_ALLOWED',
            refused.map((type) => ({
                path: 'child_type',
                message: `${type} is not allowed for ${serviceType}; use one of ${allowed.join(', ')}`,
            })),
        );
}

export function assertRecurrenceAllowed(
    serviceType: ServiceType,
    recurrence: { dates?: unknown[] | null; ranges?: unknown[] | null },
): void {
    const wanted: SlotType[] = [
        ...(recurrence.dates?.length ? (['date_time'] as const) : []),
        ...(recurrence.ranges?.length ? (['time_range'] as const) : []),
    ];

    assertSlotTypesAllowed(
        serviceType,
        wanted.map((type) => ({ child_type: type })),
    );
}

export function recurrentRangesFromInput(
    entries: RecurrentRangeInput[] | null | undefined,
    context: SlotContext,
): RecurrentRange[] | undefined {
    if (entries === null || entries === undefined) return undefined;

    return entries.map((entry) => {
        const range = rangeFor(entry, entry.day, context);

        if (!range)
            throw ApiError.unprocessable('SLOT_RANGE_REQUIRED', [
                { path: 'recurrent_ranges', message: `${entry.day} has neither from/to nor working hours` },
            ]);

        assertRange(range);

        return {
            day: entry.day,
            ...(entry.from === undefined ? {} : { from: entry.from, to: entry.to }),
            resources: entry.resources,
            ...(entry.step_minutes === undefined ? {} : { step_minutes: entry.step_minutes }),
            ...(entry.min_minutes === undefined ? {} : { min_minutes: entry.min_minutes }),
            max_minutes: entry.max_minutes ?? null,
        };
    });
}

export function optionFromInput(
    input: ServiceOptionInput,
    context: SlotContext = {},
): { option: ServiceOption; slots: SlotBody[] } {
    const serviceType = input.service_type ?? 'service_apply';
    const slots = (input.slots ?? []).map((slot) => slotFromInput(slot, context));
    assertSlotTypesAllowed(serviceType, slots);
    assertRecurrenceAllowed(serviceType, { dates: input.recurrent_dates, ranges: input.recurrent_ranges });

    return {
        option: {
            id: input.id ?? randomUUID(),
            label: input.label ?? texts.defaults.optionLabel,
            service_type: serviceType,
            enabled: input.enabled ?? true,
            recurrent_dates:
                input.recurrent_dates === null || input.recurrent_dates === undefined
                    ? undefined
                    : input.recurrent_dates.map((entry) => ({
                          day: entry.day,
                          time: entry.time.map((time) => ({ time: time.time, limit: time.limit ?? null })),
                          limit: entry.limit ?? null,
                      })),
            recurrent_ranges: recurrentRangesFromInput(input.recurrent_ranges, context),
        },
        slots,
    };
}

export interface BookingView {
    id: string;
    user_id: Types.ObjectId;
    person: string;
    phone: string;
    info: string;
    time: string | null;
    end_time: string | null;
    address: string | null;
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
    const byTime = new Map<string, BookingView[]>();
    const bySlot = new Map<string, BookingView[]>();

    for (const booking of bookings) {
        const slotKey = `${booking.option_id}|${booking.slot_id}`;
        const timeKey = `${slotKey}|${booking.slot_time ?? ''}`;
        const view: BookingView = {
            id: booking.id,
            user_id: booking.user_id,
            person: booking.person,
            phone: booking.phone,
            info: booking.info,
            time: booking.slot_time ?? null,
            end_time: booking.slot_end ?? null,
            address: booking.address ?? null,
            status: booking.status,
            created_at: booking.created_at,
        };
        byTime.set(timeKey, [...(byTime.get(timeKey) ?? []), view]);
        bySlot.set(slotKey, [...(bySlot.get(slotKey) ?? []), view]);
    }

    return options.map((option) => ({
        ...option,
        slots: option.slots.map((slot): SlotWithBookings => {
            if (TIMED_SLOT_TYPES.includes(slot.child_type)) {
                return {
                    ...slot,
                    value: {
                        ...slot.value,
                        time: (slot.value.time ?? []).map((entry) => ({
                            ...entry,
                            bookings: byTime.get(`${option.id}|${slot.id}|${entry.time}`) ?? [],
                        })),
                    },
                };
            }

            if (BOOKABLE_SLOT_TYPES.includes(slot.child_type)) {
                return {
                    ...slot,
                    value: { ...slot.value, bookings: bySlot.get(`${option.id}|${slot.id}`) ?? [] },
                };
            }

            return slot;
        }),
    }));
}

export interface Interval {
    from: string;
    to: string;
}

function clampMinutes(minutes: number): number {
    return Math.min(24 * 60, Math.max(0, minutes));
}

export function overlaps(left: Interval, right: Interval, bufferMinutes = 0): boolean {
    return (
        minutesOf(left.from) < clampMinutes(minutesOf(right.to) + bufferMinutes) &&
        clampMinutes(minutesOf(left.to) + bufferMinutes) > minutesOf(right.from)
    );
}

export function assertFitsRange(range: Range, wanted: Interval): void {
    const start = minutesOf(wanted.from);
    const end = minutesOf(wanted.to);
    const open = minutesOf(range.from);
    const length = end - start;

    if (
        start < open ||
        end > minutesOf(range.to) ||
        length < range.min_minutes ||
        (range.max_minutes !== null && length > range.max_minutes) ||
        (start - open) % range.step_minutes !== 0 ||
        (end - open) % range.step_minutes !== 0
    )
        throw ApiError.unprocessable('SLOT_RANGE_INVALID');
}

export function freeRanges(
    range: Range,
    busy: Interval[],
    bufferMinutes = 0,
    notBefore?: string,
): Interval[] {
    const open = minutesOf(range.from);
    const close = minutesOf(range.to);
    const step = range.step_minutes;
    const blocked = busy
        .map((entry) => [
            clampMinutes(minutesOf(entry.from) - bufferMinutes),
            clampMinutes(minutesOf(entry.to) + bufferMinutes),
        ])
        .sort(([left], [right]) => left! - right!);
    const gaps: [number, number][] = [];
    let cursor = notBefore === undefined ? open : Math.max(open, minutesOf(notBefore));

    for (const [start, end] of blocked) {
        if (start! > cursor) gaps.push([cursor, Math.min(start!, close)]);

        cursor = Math.max(cursor, end!);
    }

    if (cursor < close) gaps.push([cursor, close]);

    return gaps.flatMap(([start, end]) => {
        const alignedStart = open + Math.ceil((start - open) / step) * step;
        const alignedEnd = open + Math.floor((end - open) / step) * step;

        return alignedEnd - alignedStart >= range.min_minutes
            ? [{ from: timeOf(alignedStart), to: timeOf(alignedEnd) }]
            : [];
    });
}

export function rangeOf(slot: Pick<SlotBody, 'value'>): Range {
    return {
        from: slot.value.from ?? '00:00',
        to: slot.value.to ?? '00:00',
        step_minutes: slot.value.step_minutes ?? DEFAULT_RANGE_STEP_MINUTES,
        min_minutes: slot.value.min_minutes ?? slot.value.step_minutes ?? DEFAULT_RANGE_STEP_MINUTES,
        max_minutes: slot.value.max_minutes ?? null,
    };
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

function recurringDates(from: string, horizonDays: number, context: RecurrenceContext): string[] {
    const holidays = new Set(context.holidays ?? []);
    const blackouts = new Set(context.blackout_dates ?? []);
    const dates: string[] = [];

    for (let i = 1; i <= horizonDays; i += 1) {
        const date = shiftDateOnly(from, i);

        if (!blackouts.has(date) && !holidays.has(date.slice(5))) dates.push(date);
    }

    return dates;
}

export function generateRecurrentDays(
    recurrent: RecurrentDate[],
    from: string,
    horizonDays: number,
    context: RecurrenceContext = {},
): GeneratedDay[] {
    const byWeekday = new Map<number, RecurrentDate>();

    for (const entry of recurrent) byWeekday.set(WEEKDAYS.indexOf(entry.day), entry);

    const result: GeneratedDay[] = [];

    for (const date of recurringDates(from, horizonDays, context)) {
        const config = byWeekday.get(weekdayOfDateOnly(date));

        if (!config) continue;

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

export interface GeneratedRange {
    date: string;
    resource: string;
    range: Range;
}

export function generateRecurrentRanges(
    recurrent: RecurrentRange[],
    from: string,
    horizonDays: number,
    context: RecurrenceContext = {},
): GeneratedRange[] {
    const result: GeneratedRange[] = [];

    for (const date of recurringDates(from, horizonDays, context)) {
        const day = WEEKDAYS[weekdayOfDateOnly(date)]!;

        for (const entry of recurrent) {
            if (entry.day !== day) continue;

            const range = rangeFor(entry, day, context);

            if (!range || !isValidRange(range)) continue;

            for (const resource of entry.resources) result.push({ date, resource, range });
        }
    }

    return result;
}

export interface RecurrentRangePlan {
    add_slots: SlotBody[];
    update_ranges: { slot_id: string; range: Range }[];
    remove_slots: string[];
}

export function isEmptyRangePlan(plan: RecurrentRangePlan): boolean {
    return plan.add_slots.length === 0 && plan.update_ranges.length === 0 && plan.remove_slots.length === 0;
}

function sameRange(left: Range, right: Range): boolean {
    return (
        left.from === right.from &&
        left.to === right.to &&
        left.step_minutes === right.step_minutes &&
        left.min_minutes === right.min_minutes &&
        left.max_minutes === right.max_minutes
    );
}

export function planRecurrentRanges(
    slots: SlotBody[],
    generated: GeneratedRange[],
    window: { from: string; to: string },
): RecurrentRangePlan {
    const plan: RecurrentRangePlan = { add_slots: [], update_ranges: [], remove_slots: [] };
    const managed = slots.filter(
        (slot) =>
            slot.child_type === 'time_range' &&
            typeof slot.value.resource === 'string' &&
            typeof slot.value.date === 'string' &&
            slot.value.date > window.from &&
            slot.value.date <= window.to,
    );
    const byKey = new Map(managed.map((slot) => [`${slot.value.date}|${slot.value.resource}`, slot]));
    const wanted = new Set<string>();

    for (const { date, resource, range } of generated) {
        const key = `${date}|${resource}`;
        wanted.add(key);
        const slot = byKey.get(key);

        if (!slot) {
            plan.add_slots.push({
                id: randomUUID(),
                label: resource,
                child_type: 'time_range',
                value: { date, resource, ...range, booked_count: 0 },
            });
            continue;
        }

        if ((slot.value.booked_count ?? 0) === 0 && !sameRange(rangeOf(slot), range))
            plan.update_ranges.push({ slot_id: slot.id, range });
    }

    for (const slot of managed) {
        const key = `${slot.value.date}|${slot.value.resource}`;

        if (!wanted.has(key) && (slot.value.booked_count ?? 0) === 0) plan.remove_slots.push(slot.id);
    }

    return plan;
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
    if (!DATED_SLOT_TYPES.includes(slot.child_type)) return false;

    return typeof slot.value.date === 'string' && slot.value.date < today;
}
