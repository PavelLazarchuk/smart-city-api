import { Types } from 'mongoose';

import { type BookingEntity } from '../bookings/bookings.repository';
import { type SlotBody } from '../slots/schemas/slot.schema';
import { ApiError } from '../../common/http/api-error';
import {
    assertRange,
    assertRecurrenceAllowed,
    attachBookings,
    generateRecurrentDays,
    isSlotExpired,
    isEmptyPlan,
    type OptionTree,
    growTrees,
    minutesOf,
    optionFromInput,
    optionOf,
    planRecurrentDays,
    rangeOf,
    recurrentRangesFromInput,
    slotFromInput,
    slotOf,
    timeOf,
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
    slot_end: null,
    starts_at: new Date('2026-03-01T00:00:00Z'),
    ends_at: null,
    service_label: 'S',
    user_id: new Types.ObjectId(),
    person: 'P',
    phone: '4915290000000',
    info: '',
    address: null,
    fields: {},
    documents: [],
    status: 'confirmed',
    active: true,
    confirmed_at: null,
    finished_at: null,
    status_changed_by: null,
    created_by: null,
    reminder_sent_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
});

describe('slot.logic', () => {
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
        const info = slotFromInput({ child_type: 'pickup', value: { description: 'x' } });
        expect(info.value).toEqual({ description: 'x', link: undefined, price: undefined });
        expect(info.id).toMatch(/[0-9a-f-]{36}/);
    });

    it('builds options with defaults', () => {
        const { option, slots } = optionFromInput({
            recurrent_dates: [{ day: 'monday', time: [{ time: '09:00' }] }],
            slots: [{ child_type: 'apply', value: {} }],
        });
        expect(option.service_type).toBe('service_apply');
        expect(option.enabled).toBe(true);
        expect(option.recurrent_dates).toEqual([
            { day: 'monday', time: [{ time: '09:00', limit: null }], limit: null },
        ]);
        expect(option).not.toHaveProperty('slots');
        expect(slots).toEqual([
            expect.objectContaining({ child_type: 'apply', value: { limit: null, booked_count: 0 } }),
        ]);
        expect(optionFromInput({ recurrent_dates: null }).option.recurrent_dates).toBeUndefined();
    });

    it('grows each service its own slots per option, in the order they were stored', () => {
        const first = new Types.ObjectId();
        const second = new Types.ObjectId();
        const option = { label: 'x', service_type: 'service_apply' as const, enabled: true };
        const slot = (serviceId: Types.ObjectId, optionId: string, id: string) => ({
            service_id: serviceId,
            option_id: optionId,
            id,
            label: id,
            child_type: 'apply' as const,
            value: { limit: null, booked_count: 0 },
        });
        const [one, two] = growTrees(
            [
                {
                    _id: first,
                    options: [
                        { ...option, id: 'o1' },
                        { ...option, id: 'o2' },
                    ],
                },
                { _id: second, options: [{ ...option, id: 'o1' }] },
            ],
            [
                slot(first, 'o1', 'a'),
                slot(second, 'o1', 'c'),
                slot(first, 'o1', 'b'),
                slot(first, 'gone', 'd'),
            ],
        );
        expect(one!.options.map((item) => item.slots.map((entry) => entry.id))).toEqual([['a', 'b'], []]);
        expect(two!.options[0]!.slots).toEqual([
            { id: 'c', label: 'c', child_type: 'apply', value: { limit: null, booked_count: 0 } },
        ]);
    });

    it('grafts bookings from their own collection back onto the right slot and time entry', () => {
        const options: OptionTree[] = [
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
        const days = generateRecurrentDays(
            [
                { day: 'monday', time: [{ time: '09:00', limit: 1 }] },
                { day: 'sunday', time: [] },
            ],
            '2026-09-05',
            14,
        );
        expect(days.map((day) => day.date)).toEqual(['2026-09-07', '2026-09-14']);
        expect(days[0]!.time).toEqual([{ time: '09:00', limit: 1 }]);
    });

    it('planRecurrentDays adds missing dates and times and drops only unbooked stale ones', () => {
        const slots: SlotBody[] = [
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

        const settled: SlotBody[] = [
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
        expect(isSlotExpired({ child_type: 'date', value: { date: '2026-01-01' } }, '2026-01-02')).toBe(true);
        expect(isSlotExpired({ child_type: 'date', value: { date: '2026-01-02' } }, '2026-01-02')).toBe(
            false,
        );
        expect(isSlotExpired({ child_type: 'apply', value: {} }, '2026-01-02')).toBe(false);
    });
});

function errorOf(run: () => unknown): { code: string; details?: unknown } | null {
    try {
        run();

        return null;
    } catch (error) {
        if (error instanceof ApiError) return { code: error.code, details: error.details };

        throw error;
    }
}

describe('slot.logic — lookups, ranges and recurrence input', () => {
    const slot: SlotBody = {
        id: 's1',
        label: 'S',
        child_type: 'apply',
        value: { limit: null, booked_count: 0 },
    };
    const service = { options: [{ id: 'o1', slots: [slot] }] };

    it('finds an option and a slot or answers 404 with its own code', () => {
        expect(optionOf(service, 'o1').id).toBe('o1');
        expect(slotOf(optionOf(service, 'o1'), 's1')).toBe(slot);
        expect(errorOf(() => optionOf(service, 'o2'))?.code).toBe('OPTION_NOT_FOUND');
        expect(errorOf(() => slotOf(optionOf(service, 'o1'), 's2'))?.code).toBe('SLOT_NOT_FOUND');
    });

    it.each([
        ['an empty span', { from: '10:00', to: '10:00', min_minutes: 30, max_minutes: null }],
        ['an inverted span', { from: '11:00', to: '10:00', min_minutes: 30, max_minutes: null }],
        [
            'a minimum longer than the span',
            { from: '10:00', to: '10:30', min_minutes: 45, max_minutes: null },
        ],
        ['a maximum below the minimum', { from: '09:00', to: '18:00', min_minutes: 60, max_minutes: 30 }],
    ])('refuses a range with %s', (_, range) => {
        expect(errorOf(() => assertRange({ step_minutes: 15, ...range }))?.code).toBe('SLOT_RANGE_INVALID');
    });

    it('accepts a range whose minimum fills the whole span', () => {
        expect(
            errorOf(() =>
                assertRange({
                    from: '10:00',
                    to: '11:00',
                    step_minutes: 15,
                    min_minutes: 60,
                    max_minutes: 60,
                }),
            ),
        ).toBeNull();
    });

    it('allows recurrence only for the slot types of the service type', () => {
        expect(
            errorOf(() => assertRecurrenceAllowed('service_apply', { dates: [{}], ranges: [{}] })),
        ).toBeNull();
        expect(errorOf(() => assertRecurrenceAllowed('service_visit', { ranges: [{}] }))).toBeNull();
        expect(
            errorOf(() => assertRecurrenceAllowed('service_payment', { dates: [], ranges: null })),
        ).toBeNull();
        expect(errorOf(() => assertRecurrenceAllowed('service_payment', { dates: [{}] }))?.code).toBe(
            'SLOT_TYPE_NOT_ALLOWED',
        );
        expect(errorOf(() => assertRecurrenceAllowed('service_delivery', { ranges: [{}] }))?.code).toBe(
            'SLOT_TYPE_NOT_ALLOWED',
        );
    });

    it('keeps recurrent ranges absent when none were sent', () => {
        expect(recurrentRangesFromInput(undefined, {})).toBeUndefined();
        expect(recurrentRangesFromInput(null, {})).toBeUndefined();
        expect(recurrentRangesFromInput([], {})).toEqual([]);
    });

    it('stores only what was sent, so later working hours still apply', () => {
        expect(
            recurrentRangesFromInput(
                [
                    { day: 'monday', from: '09:00', to: '12:00', resources: ['Court 1'], step_minutes: 30 },
                    { day: 'tuesday', resources: ['Court 1', 'Court 2'] },
                ],
                { working_hours: [{ day: 'tuesday', from: '10:00', to: '14:00' }] },
            ),
        ).toEqual([
            {
                day: 'monday',
                from: '09:00',
                to: '12:00',
                resources: ['Court 1'],
                step_minutes: 30,
                max_minutes: null,
            },
            { day: 'tuesday', resources: ['Court 1', 'Court 2'], max_minutes: null },
        ]);
    });

    it('refuses a recurrent range with neither times nor working hours that day', () => {
        expect(
            errorOf(() =>
                recurrentRangesFromInput([{ day: 'sunday', resources: ['Court 1'] }], {
                    working_hours: [{ day: 'monday', from: '09:00', to: '18:00' }],
                }),
            ),
        ).toEqual({
            code: 'SLOT_RANGE_REQUIRED',
            details: [{ path: 'recurrent_ranges', message: 'sunday has neither from/to nor working hours' }],
        });
    });

    it('refuses a recurrent range whose minimum does not fit', () => {
        expect(
            errorOf(() =>
                recurrentRangesFromInput(
                    [{ day: 'monday', from: '09:00', to: '09:30', resources: ['Court 1'], min_minutes: 60 }],
                    {},
                ),
            )?.code,
        ).toBe('SLOT_RANGE_INVALID');
    });

    it('fills a stored range with the defaults', () => {
        expect(rangeOf({ value: {} })).toEqual({
            from: '00:00',
            to: '00:00',
            step_minutes: 30,
            min_minutes: 30,
            max_minutes: null,
        });
        expect(rangeOf({ value: { from: '09:00', to: '12:00', step_minutes: 15 } })).toMatchObject({
            step_minutes: 15,
            min_minutes: 15,
        });
        expect(rangeOf({ value: { step_minutes: 15, min_minutes: 60, max_minutes: 120 } })).toMatchObject({
            min_minutes: 60,
            max_minutes: 120,
        });
    });

    it('converts between HH:mm and minutes of the day', () => {
        expect(minutesOf('00:00')).toBe(0);
        expect(minutesOf('09:05')).toBe(545);
        expect(minutesOf('23:59')).toBe(1439);
        expect(timeOf(0)).toBe('00:00');
        expect(timeOf(545)).toBe('09:05');
        expect(timeOf(1440)).toBe('24:00');

        for (const time of ['00:00', '07:30', '12:45', '23:59']) expect(timeOf(minutesOf(time))).toBe(time);
    });
});
