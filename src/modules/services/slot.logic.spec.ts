import { Types } from 'mongoose';

import { type BookingEntity } from '../bookings/bookings.repository';
import { type ServiceOption, type Slot } from './schemas/service.schema';
import {
    attachBookings,
    formatDateOnly,
    generateRecurrentDays,
    isSlotExpired,
    isEmptyPlan,
    mergeBookings,
    optionFromInput,
    planRecurrentDays,
    slotFromInput,
    timesFromWorkingHours,
} from './slot.logic';

const booking = (
    overrides: Partial<BookingEntity> & { option_id: string; slot_id: string },
): BookingEntity => ({
    _id: new Types.ObjectId(),
    id: `b-${overrides.slot_id}-${overrides.slot_time ?? ''}`,
    service_id: new Types.ObjectId(),
    organization_id: new Types.ObjectId(),
    child_type: 'date_time',
    slot_date: '2026-03-01',
    slot_time: null,
    service_label: 'S',
    user_id: new Types.ObjectId(),
    person: 'P',
    phone: '375290000000',
    info: '',
    fields: {},
    documents: [],
    status: 'confirmed',
    active: true,
    confirmed_at: null,
    finished_at: null,
    status_changed_by: null,
    reminder_sent_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
});

describe('slot.logic', () => {
    it('formats dates as YYYY-MM-DD in local time', () => {
        expect(formatDateOnly(new Date(2026, 0, 5))).toBe('2026-01-05');
    });

    it('builds persisted slots from input with counters seeded', () => {
        const dateTime = slotFromInput({
            child_type: 'date_time',
            value: { date: '2026-03-01', time: [{ time: '09:00', limit: 3 }, { time: '10:00' }] },
        });
        expect(dateTime.value.time).toEqual([
            { time: '09:00', limit: 3, booked_count: 0 },
            { time: '10:00', limit: null, booked_count: 0 },
        ]);
        const apply = slotFromInput({ child_type: 'apply', value: { limit: 5 } });
        expect(apply.value).toEqual({ limit: 5, booked_count: 0 });
        const info = slotFromInput({ child_type: 'delivery', value: { description: 'x' } });
        expect(info.value).toEqual({ description: 'x', link: undefined, price: undefined });
        expect(info.id).toMatch(/[0-9a-f-]{36}/);
    });

    it('builds options with defaults', () => {
        const option = optionFromInput({ recurrent_dates: [{ day: 'monday', time: [{ time: '09:00' }] }] });
        expect(option.service_type).toBe('service_apply');
        expect(option.enabled).toBe(true);
        expect(option.recurrent_dates).toEqual([
            { day: 'monday', time: [{ time: '09:00', limit: null }], limit: null },
        ]);
        expect(optionFromInput({ recurrent_dates: null }).recurrent_dates).toBeUndefined();
    });

    it('mergeBookings keeps occupancy counters of slots that survive an options replacement', () => {
        const existing: ServiceOption[] = [
            {
                id: 'o1',
                label: 'x',
                service_type: 'service_apply',
                enabled: true,
                slots: [
                    {
                        id: 's1',
                        label: 'd',
                        child_type: 'date_time',
                        value: {
                            date: '2026-03-01',
                            time: [{ time: '09:00', limit: 2, booked_count: 1 }],
                        },
                    },
                    {
                        id: 's2',
                        label: 'a',
                        child_type: 'apply',
                        value: { limit: null, booked_count: 1 },
                    },
                ],
            },
        ];
        const incoming: ServiceOption[] = [
            {
                id: 'o1',
                label: 'renamed',
                service_type: 'service_apply',
                enabled: true,
                slots: [
                    {
                        id: 's1',
                        label: 'd',
                        child_type: 'date_time',
                        value: {
                            date: '2026-03-01',
                            time: [
                                { time: '09:00', limit: 5, booked_count: 0 },
                                { time: '11:00', limit: 1, booked_count: 0 },
                            ],
                        },
                    },
                    {
                        id: 's2',
                        label: 'a',
                        child_type: 'apply',
                        value: { limit: 3, booked_count: 0 },
                    },
                    {
                        id: 's3',
                        label: 'new',
                        child_type: 'apply',
                        value: { limit: null, booked_count: 0 },
                    },
                ],
            },
            { id: 'o2', label: 'fresh', service_type: 'service_payment', enabled: true, slots: [] },
        ];
        const merged = mergeBookings(existing, incoming);
        const time = merged[0]!.slots[0]!.value.time!;
        expect(time[0]).toMatchObject({ time: '09:00', limit: 5, booked_count: 1 });
        expect(time[1]).toMatchObject({ time: '11:00', booked_count: 0 });
        expect(merged[0]!.slots[1]!.value).toMatchObject({ limit: 3, booked_count: 1 });
        expect(merged[0]!.slots[2]!.value.booked_count).toBe(0);
        expect(merged[1]!.slots).toEqual([]);
        expect(merged[0]!.label).toBe('renamed');
    });

    it('mergeBookings keeps a booked time the edit renamed away, and drops an unbooked one', () => {
        const existing: ServiceOption[] = [
            {
                id: 'o1',
                label: 'x',
                service_type: 'service_apply',
                enabled: true,
                slots: [
                    {
                        id: 's1',
                        label: 'd',
                        child_type: 'date_time',
                        value: {
                            date: '2026-03-01',
                            time: [
                                { time: '10:00', limit: 2, booked_count: 1 },
                                { time: '14:00', limit: 2, booked_count: 0 },
                            ],
                        },
                    },
                ],
            },
        ];
        const incoming: ServiceOption[] = [
            {
                id: 'o1',
                label: 'x',
                service_type: 'service_apply',
                enabled: true,
                slots: [
                    {
                        id: 's1',
                        label: 'd',
                        child_type: 'date_time',
                        value: {
                            date: '2026-03-01',
                            time: [{ time: '10:30', limit: 2, booked_count: 0 }],
                        },
                    },
                ],
            },
        ];
        const time = mergeBookings(existing, incoming)[0]!.slots[0]!.value.time!;
        expect(time.map((entry) => entry.time)).toEqual(['10:30', '10:00']);
        expect(time[1]).toMatchObject({ booked_count: 1 });
    });

    it('grafts bookings from their own collection back onto the right slot and time entry', () => {
        const options: ServiceOption[] = [
            {
                id: 'o1',
                label: 'x',
                service_type: 'service_apply',
                enabled: true,
                slots: [
                    {
                        id: 's1',
                        label: 'd',
                        child_type: 'date_time',
                        value: {
                            date: '2026-03-01',
                            time: [{ time: '09:00', limit: null, booked_count: 2 }],
                        },
                    },
                    {
                        id: 's2',
                        label: 'a',
                        child_type: 'date',
                        value: {
                            date: '2026-03-02',
                            limit: null,
                            booked_count: 1,
                        },
                    },
                ],
            },
        ];
        const attached = attachBookings(options, [
            booking({ option_id: 'o1', slot_id: 's1', slot_time: '09:00' }),
            booking({ option_id: 'o1', slot_id: 's1', slot_time: '09:00', id: 'second' }),
            booking({ option_id: 'o1', slot_id: 's2', child_type: 'date' }),
            booking({ option_id: 'o1', slot_id: 'gone', child_type: 'date' }),
        ]);
        expect(attached[0]!.slots[0]!.value.time![0]!.bookings).toHaveLength(2);
        expect(attached[0]!.slots[1]!.value.bookings).toHaveLength(1);
    });

    it('generates recurrent days over the horizon starting tomorrow; a day without times is skipped', () => {
        const from = new Date(2026, 8, 5);
        const days = generateRecurrentDays(
            [
                { day: 'monday', time: [{ time: '09:00', limit: 1 }] },
                { day: 'sunday', time: [] },
            ],
            from,
            14,
        );
        expect(days.map((day) => day.date)).toEqual(['2026-09-07', '2026-09-14']);
        expect(days[0]!.time).toEqual([{ time: '09:00', limit: 1 }]);
    });

    it('planRecurrentDays adds missing dates and times and drops only unbooked stale ones', () => {
        const slots: Slot[] = [
            {
                id: 's1',
                label: 'd',
                child_type: 'date_time',
                value: {
                    date: '2026-09-07',
                    time: [
                        { time: '08:00', limit: null, booked_count: 1 },
                        { time: '12:00', limit: null, booked_count: 0 },
                    ],
                },
            },
        ];
        const plan = planRecurrentDays(slots, [
            { date: '2026-09-07', time: [{ time: '09:00', limit: 2 }] },
            { date: '2026-09-14', time: [{ time: '09:00', limit: 2 }] },
        ]);
        expect(isEmptyPlan(plan)).toBe(false);
        expect(plan.add_slots).toHaveLength(1);
        expect(plan.add_slots[0]!.value.date).toBe('2026-09-14');
        expect(plan.add_times).toEqual([
            { slot_id: 's1', entries: [{ time: '09:00', limit: 2, booked_count: 0 }] },
        ]);
        expect(plan.remove_times).toEqual([{ slot_id: 's1', times: ['12:00'] }]);
        expect(slots[0]!.value.time).toHaveLength(2);

        const settled: Slot[] = [
            {
                id: 's1',
                label: 'd',
                child_type: 'date_time',
                value: {
                    date: '2026-09-07',
                    time: [
                        { time: '08:00', limit: null, booked_count: 1 },
                        { time: '09:00', limit: 2, booked_count: 0 },
                    ],
                },
            },
        ];
        const unchanged = planRecurrentDays(settled, [
            {
                date: '2026-09-07',
                time: [
                    { time: '09:00', limit: 2 },
                    { time: '08:00', limit: null },
                ],
            },
        ]);
        expect(isEmptyPlan(unchanged)).toBe(true);
    });

    it('isSlotExpired compares date-only strings and ignores undated slots', () => {
        expect(
            isSlotExpired(
                { id: 'x', label: 'x', child_type: 'date', value: { date: '2026-01-01' } },
                '2026-01-02',
            ),
        ).toBe(true);
        expect(
            isSlotExpired(
                { id: 'x', label: 'x', child_type: 'date', value: { date: '2026-01-02' } },
                '2026-01-02',
            ),
        ).toBe(false);
        expect(isSlotExpired({ id: 'x', label: 'x', child_type: 'apply', value: {} }, '2026-01-02')).toBe(
            false,
        );
    });
});

describe('slot.logic — working hours and closures', () => {
    it('cuts opening intervals into appointment starts, keeping a whole appointment inside', () => {
        const hours = [
            { day: 'monday' as const, from: '09:00', to: '10:30' },
            { day: 'monday' as const, from: '13:00', to: '13:45' },
            { day: 'tuesday' as const, from: '09:00', to: '17:00' },
        ];
        expect(timesFromWorkingHours(hours, 'monday', 30, 15, 2)).toEqual([
            { time: '09:00', limit: 2 },
            { time: '09:45', limit: 2 },
            { time: '13:00', limit: 2 },
        ]);
        expect(timesFromWorkingHours(hours, 'sunday', 30, 0, null)).toEqual([]);
    });

    it('falls back to working hours for a weekday without times and skips holidays and blackouts', () => {
        // 2026-09-05 is a Saturday; the Mondays inside a 14-day horizon are 09-07 and 09-14.
        const days = generateRecurrentDays(
            [
                { day: 'monday', time: [], limit: 1 },
                { day: 'wednesday', time: [{ time: '12:00', limit: null }] },
            ],
            new Date(2026, 8, 5),
            14,
            {
                working_hours: [{ day: 'monday', from: '09:00', to: '10:00' }],
                duration_minutes: 20,
                buffer_minutes: 10,
                holidays: ['09-09'],
                blackout_dates: ['2026-09-14'],
            },
        );
        expect(days).toEqual([
            {
                date: '2026-09-07',
                time: [
                    { time: '09:00', limit: 1 },
                    { time: '09:30', limit: 1 },
                ],
            },
            { date: '2026-09-16', time: [{ time: '12:00', limit: null }] },
        ]);
    });
});
