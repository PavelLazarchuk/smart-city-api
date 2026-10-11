import { Types } from 'mongoose';

import { type BookingEntity } from '../bookings/bookings.repository';
import { ApiError } from '../../common/http/api-error';
import {
    assertFitsRange,
    assertSlotTypesAllowed,
    attachBookings,
    freeRanges,
    generateRecurrentRanges,
    isEmptyRangePlan,
    overlaps,
    planRecurrentRanges,
    type Range,
    generateRecurrentDays,
    optionFromInput,
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
            '2026-09-05',
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

    it('builds interval and call-back slots, taking an interval from working hours when it has none', () => {
        const explicit = slotFromInput({
            child_type: 'time_range',
            value: { date: '2026-09-07', from: '08:00', to: '12:00', step_minutes: 15, min_minutes: 60 },
        });
        expect(explicit.value).toEqual({
            date: '2026-09-07',
            from: '08:00',
            to: '12:00',
            step_minutes: 15,
            min_minutes: 60,
            max_minutes: null,
            booked_count: 0,
        });

        const inherited = slotFromInput(
            { child_type: 'time_range', value: { date: '2026-09-07' } },
            {
                working_hours: [
                    { day: 'monday', from: '14:00', to: '18:00' },
                    { day: 'monday', from: '09:00', to: '12:00' },
                    { day: 'tuesday', from: '07:00', to: '20:00' },
                ],
                duration_minutes: 45,
            },
        );
        expect(inherited.value).toMatchObject({
            from: '09:00',
            to: '18:00',
            step_minutes: 45,
            min_minutes: 45,
        });

        expect(() => slotFromInput({ child_type: 'time_range', value: { date: '2026-09-07' } })).toThrow(
            ApiError,
        );
        expect(() =>
            slotFromInput({
                child_type: 'time_range',
                value: { date: '2026-09-07', from: '09:00', to: '09:30', min_minutes: 60 },
            }),
        ).toThrow(ApiError);

        const callback = slotFromInput({
            child_type: 'callback',
            value: { date: '2026-09-07', time: [{ time: '10:00', to: '12:00', limit: 5 }] },
        });
        expect(callback.value.time).toEqual([{ time: '10:00', to: '12:00', limit: 5, booked_count: 0 }]);
    });

    it('allows only the slot types that belong to the option service type', () => {
        expect(() =>
            assertSlotTypesAllowed('service_visit', [
                { child_type: 'time_range' },
                { child_type: 'date_time' },
            ]),
        ).not.toThrow();
        expect(() => assertSlotTypesAllowed('service_delivery', [{ child_type: 'courier' }])).not.toThrow();
        expect(() => assertSlotTypesAllowed('service_payment', [{ child_type: 'pickup' }])).toThrow(ApiError);
        expect(() => assertSlotTypesAllowed('service_apply', [{ child_type: 'paycard' }])).toThrow(ApiError);
        expect(() =>
            optionFromInput({
                service_type: 'service_delivery',
                slots: [{ child_type: 'apply', value: {} }],
            }),
        ).toThrow(ApiError);
    });

    it('accepts an interval only on the step grid, inside the range and within the duration limits', () => {
        const range: Range = {
            from: '08:00',
            to: '12:00',
            step_minutes: 30,
            min_minutes: 60,
            max_minutes: 120,
        };
        expect(() => assertFitsRange(range, { from: '08:30', to: '10:00' })).not.toThrow();
        expect(() => assertFitsRange(range, { from: '08:15', to: '09:15' })).toThrow(ApiError);
        expect(() => assertFitsRange(range, { from: '07:30', to: '09:00' })).toThrow(ApiError);
        expect(() => assertFitsRange(range, { from: '11:30', to: '12:30' })).toThrow(ApiError);
        expect(() => assertFitsRange(range, { from: '09:00', to: '09:30' })).toThrow(ApiError);
        expect(() => assertFitsRange(range, { from: '08:00', to: '10:30' })).toThrow(ApiError);
    });

    it('treats touching intervals as free and a buffer as part of the busy time', () => {
        expect(overlaps({ from: '10:00', to: '11:00' }, { from: '11:00', to: '12:00' })).toBe(false);
        expect(overlaps({ from: '10:00', to: '11:30' }, { from: '11:00', to: '12:00' })).toBe(true);
        expect(overlaps({ from: '11:00', to: '12:00' }, { from: '10:00', to: '11:00' }, 15)).toBe(true);
    });

    it('lists free intervals snapped to the step grid, around bookings and their buffer', () => {
        const range: Range = {
            from: '08:00',
            to: '14:00',
            step_minutes: 30,
            min_minutes: 60,
            max_minutes: null,
        };
        expect(freeRanges(range, [])).toEqual([{ from: '08:00', to: '14:00' }]);
        expect(
            freeRanges(range, [
                { from: '09:00', to: '10:00' },
                { from: '12:30', to: '13:00' },
            ]),
        ).toEqual([
            { from: '08:00', to: '09:00' },
            { from: '10:00', to: '12:30' },
            { from: '13:00', to: '14:00' },
        ]);
        expect(freeRanges(range, [{ from: '09:00', to: '10:00' }], 10)).toEqual([
            { from: '10:30', to: '14:00' },
        ]);
        expect(freeRanges(range, [], 0, '12:10')).toEqual([{ from: '12:30', to: '14:00' }]);
        expect(freeRanges(range, [{ from: '08:00', to: '14:00' }])).toEqual([]);
    });

    it('grafts interval bookings onto their slot whatever their start time', () => {
        const attached = attachBookings(
            [
                {
                    id: 'o1',
                    label: 'x',
                    service_type: 'service_visit',
                    enabled: true,
                    slots: [
                        {
                            id: 'r1',
                            label: 'r',
                            child_type: 'time_range',
                            value: { date: '2026-03-01', from: '08:00', to: '12:00', booked_count: 2 },
                        },
                    ],
                },
            ],
            [
                booking({
                    option_id: 'o1',
                    slot_id: 'r1',
                    child_type: 'time_range',
                    slot_time: '08:00',
                    slot_end: '09:00',
                    address: 'Main st. 1',
                }),
                booking({ option_id: 'o1', slot_id: 'r1', child_type: 'time_range', slot_time: '10:00' }),
            ],
        );
        expect(attached[0]!.slots[0]!.value.bookings).toHaveLength(2);
        expect(attached[0]!.slots[0]!.value.bookings![0]).toMatchObject({
            time: '08:00',
            end_time: '09:00',
            address: 'Main st. 1',
        });
    });

    it('generates one interval per resource and weekday, from working hours when the entry has none', () => {
        const generated = generateRecurrentRanges(
            [
                { day: 'monday', resources: ['Court 1', 'Court 2'], max_minutes: null },
                { day: 'wednesday', from: '10:00', to: '12:00', resources: ['Court 1'], max_minutes: 60 },
                { day: 'friday', resources: ['Court 1'], max_minutes: null },
            ],
            '2026-09-05',
            7,
            {
                working_hours: [
                    { day: 'monday', from: '08:00', to: '12:00' },
                    { day: 'monday', from: '13:00', to: '20:00' },
                ],
                duration_minutes: 30,
                holidays: ['09-09'],
            },
        );
        expect(generated).toEqual([
            {
                date: '2026-09-07',
                resource: 'Court 1',
                range: { from: '08:00', to: '20:00', step_minutes: 30, min_minutes: 30, max_minutes: null },
            },
            {
                date: '2026-09-07',
                resource: 'Court 2',
                range: { from: '08:00', to: '20:00', step_minutes: 30, min_minutes: 30, max_minutes: null },
            },
        ]);
    });

    it('plans interval slots: adds missing ones, refreshes free ones, keeps booked ones and drops the rest', () => {
        const range: Range = {
            from: '08:00',
            to: '12:00',
            step_minutes: 30,
            min_minutes: 60,
            max_minutes: null,
        };
        const slot = (
            id: string,
            date: string,
            resource: string | undefined,
            booked: number,
            from = '08:00',
        ) => ({
            id,
            label: id,
            child_type: 'time_range' as const,
            value: { date, resource, ...range, from, booked_count: booked },
        });
        const window = { from: '2026-09-05', to: '2026-09-12' };
        const plan = planRecurrentRanges(
            [
                slot('same', '2026-09-07', 'Court 1', 0),
                slot('stale', '2026-09-07', 'Court 2', 0, '09:00'),
                slot('stale-booked', '2026-09-08', 'Court 2', 1, '09:00'),
                slot('gone', '2026-09-08', 'Court 3', 0),
                slot('gone-booked', '2026-09-08', 'Court 4', 2),
                slot('manual', '2026-09-08', undefined, 0),
                slot('outside', '2026-09-20', 'Court 9', 0),
            ],
            [
                { date: '2026-09-07', resource: 'Court 1', range },
                { date: '2026-09-07', resource: 'Court 2', range },
                { date: '2026-09-08', resource: 'Court 2', range },
                { date: '2026-09-09', resource: 'Court 1', range },
            ],
            window,
        );
        expect(plan.add_slots).toEqual([
            expect.objectContaining({
                label: 'Court 1',
                child_type: 'time_range',
                value: { date: '2026-09-09', resource: 'Court 1', ...range, booked_count: 0 },
            }),
        ]);
        expect(plan.update_ranges).toEqual([{ slot_id: 'stale', range }]);
        expect(plan.remove_slots).toEqual(['gone']);
        expect(
            isEmptyRangePlan(
                planRecurrentRanges(
                    [slot('same', '2026-09-07', 'Court 1', 0)],
                    [{ date: '2026-09-07', resource: 'Court 1', range }],
                    window,
                ),
            ),
        ).toBe(true);
    });
});
