import { Types } from 'mongoose';

import { ApiError } from '../../common/http/api-error';
import { DAY_MS } from '../../common/time/zone';
import { type BookingPolicy } from '../services/schemas/service.schema';
import {
    assertBookingWindow,
    assertCancelDeadline,
    cancelDeadlinePassed,
    inForce,
    liftedByCorrection,
    manualSuspensionEnd,
    noShowCountedSince,
    noShowEnabled,
    noShowSanction,
    resolveCancel,
} from './booking-policy';
import { type BookingSuspension } from './schemas/suspension.schema';

const NOW = new Date('2026-10-05T10:00:00Z');
const MINUTE = 60_000;

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

function codeOf(run: () => unknown): string | null {
    try {
        run();

        return null;
    } catch (error) {
        if (error instanceof ApiError) return error.code;

        throw error;
    }
}

const policy = (overrides: Partial<BookingPolicy> = {}): Partial<BookingPolicy> => ({
    lead_time_minutes: null,
    max_advance_days: null,
    cancel_deadline_minutes: null,
    late_cancel: 'forbid',
    no_show_limit: null,
    no_show_window_days: null,
    no_show_suspension_days: null,
    ...overrides,
});

type Row = Pick<
    BookingSuspension,
    'suspended' | 'until' | 'kind' | 'reason' | 'suspended_by' | 'booking_ids'
>;

const row = (overrides: Partial<Row> = {}): Row => ({
    suspended: false,
    until: null,
    kind: null,
    reason: null,
    suspended_by: null,
    booking_ids: [],
    ...overrides,
});

describe('booking window', () => {
    it('lets anything through without a policy', () => {
        expect(codeOf(() => assertBookingWindow(undefined, at(-DAY_MS), NOW, 'UTC'))).toBeNull();
        expect(codeOf(() => assertBookingWindow(policy(), at(365 * DAY_MS), NOW, 'UTC'))).toBeNull();
    });

    it('refuses a start closer than the lead time', () => {
        const lead = policy({ lead_time_minutes: 60 });

        expect(codeOf(() => assertBookingWindow(lead, at(59 * MINUTE), NOW, 'UTC'))).toBe(
            'BOOKING_LEAD_TIME',
        );
        expect(codeOf(() => assertBookingWindow(lead, at(60 * MINUTE), NOW, 'UTC'))).toBeNull();
    });

    it('closes the window at the end of the last allowed local day', () => {
        const advance = policy({ max_advance_days: 2 });

        expect(
            codeOf(() => assertBookingWindow(advance, new Date('2026-10-07T20:59:00Z'), NOW, 'Europe/Kyiv')),
        ).toBeNull();
        expect(
            codeOf(() => assertBookingWindow(advance, new Date('2026-10-07T21:00:00Z'), NOW, 'Europe/Kyiv')),
        ).toBe('BOOKING_TOO_FAR_AHEAD');
    });

    it('counts the days from the organization’s date, not from UTC', () => {
        const today = policy({ max_advance_days: 0 });
        const lateEvening = new Date('2026-10-05T22:30:00Z');
        const nextMorning = new Date('2026-10-06T10:00:00Z');

        expect(codeOf(() => assertBookingWindow(today, nextMorning, lateEvening, 'Europe/Kyiv'))).toBeNull();
        expect(codeOf(() => assertBookingWindow(today, nextMorning, lateEvening, 'UTC'))).toBe(
            'BOOKING_TOO_FAR_AHEAD',
        );
    });
});

describe('cancel deadline', () => {
    const deadline = policy({ cancel_deadline_minutes: 120 });

    it('has passed only inside the deadline before the start', () => {
        expect(cancelDeadlinePassed(deadline, at(119 * MINUTE), NOW)).toBe(true);
        expect(cancelDeadlinePassed(deadline, at(120 * MINUTE), NOW)).toBe(false);
        expect(cancelDeadlinePassed(deadline, at(-MINUTE), NOW)).toBe(true);
    });

    it('never passes without a deadline or a start', () => {
        expect(cancelDeadlinePassed(policy(), at(MINUTE), NOW)).toBe(false);
        expect(cancelDeadlinePassed(undefined, at(MINUTE), NOW)).toBe(false);
        expect(cancelDeadlinePassed(deadline, null, NOW)).toBe(false);
    });

    it('refuses a reschedule once it has passed', () => {
        expect(codeOf(() => assertCancelDeadline(deadline, at(MINUTE), NOW))).toBe(
            'BOOKING_CANCEL_DEADLINE_PASSED',
        );
        expect(codeOf(() => assertCancelDeadline(deadline, at(DAY_MS), NOW))).toBeNull();
    });
});

describe('late cancel', () => {
    const forbid = policy({ cancel_deadline_minutes: 60 });
    const noShow = policy({ cancel_deadline_minutes: 60, late_cancel: 'no_show' });

    it('is an ordinary cancel before the deadline', () => {
        expect(resolveCancel(forbid, at(2 * 60 * MINUTE), NOW)).toBe('on_time');
        expect(resolveCancel(noShow, at(2 * 60 * MINUTE), NOW)).toBe('on_time');
    });

    it('is refused after the deadline under forbid', () => {
        expect(codeOf(() => resolveCancel(forbid, at(30 * MINUTE), NOW))).toBe(
            'BOOKING_CANCEL_DEADLINE_PASSED',
        );
    });

    it('goes through as a late cancel under no_show while the visit is still ahead', () => {
        expect(resolveCancel(noShow, at(30 * MINUTE), NOW)).toBe('late');
    });

    it('is refused under no_show once the visit has started', () => {
        expect(codeOf(() => resolveCancel(noShow, NOW, NOW))).toBe('BOOKING_CANCEL_DEADLINE_PASSED');
        expect(codeOf(() => resolveCancel(noShow, at(-MINUTE), NOW))).toBe('BOOKING_CANCEL_DEADLINE_PASSED');
    });
});

describe('suspension state', () => {
    it.each([
        ['no row', null, false],
        ['a lifted row', row({ suspended: false, until: at(DAY_MS) }), false],
        ['an indefinite suspension', row({ suspended: true, until: null }), true],
        ['a suspension still running', row({ suspended: true, until: at(MINUTE) }), true],
        ['a suspension ending right now', row({ suspended: true, until: NOW }), false],
        ['an expired suspension', row({ suspended: true, until: at(-MINUTE) }), false],
    ])('%s is in force: %s', (_, value, expected) => {
        expect(inForce(value, NOW)).toBe(expected);
    });

    it('ends a manual suspension after the given days or never', () => {
        expect(manualSuspensionEnd(3, NOW)).toEqual(at(3 * DAY_MS));
        expect(manualSuspensionEnd(undefined, NOW)).toBeNull();
        expect(manualSuspensionEnd(null, NOW)).toBeNull();
        expect(manualSuspensionEnd(0, NOW)).toBeNull();
    });
});

describe('no-show sanctions', () => {
    const sanctions = policy({ no_show_limit: 2, no_show_window_days: 30, no_show_suspension_days: 7 });

    it('are on only with both a limit and a suspension length', () => {
        expect(noShowEnabled(sanctions)).toBe(true);
        expect(noShowEnabled(policy({ no_show_limit: 2 }))).toBe(false);
        expect(noShowEnabled(policy({ no_show_suspension_days: 7 }))).toBe(false);
        expect(noShowEnabled(undefined)).toBe(false);
    });

    it('count from the later of the window start and the last reset', () => {
        expect(noShowCountedSince(null, policy(), NOW)).toEqual(new Date(0));
        expect(noShowCountedSince(null, sanctions, NOW)).toEqual(at(-30 * DAY_MS));
        expect(noShowCountedSince(at(-DAY_MS), sanctions, NOW)).toEqual(at(-DAY_MS));
        expect(noShowCountedSince(at(-40 * DAY_MS), sanctions, NOW)).toEqual(at(-30 * DAY_MS));
    });

    it('do nothing below the limit or when switched off', () => {
        expect(noShowSanction(sanctions, row(), ['a'], NOW)).toBeNull();
        expect(noShowSanction(policy(), row(), ['a', 'b', 'c'], NOW)).toBeNull();
    });

    it('suspend for the configured days once the limit is reached', () => {
        expect(noShowSanction(sanctions, row(), ['a', 'b'], NOW)).toEqual({
            until: at(7 * DAY_MS),
            kind: 'no_show',
            reason: null,
            booking_ids: ['a', 'b'],
            suspended_by: null,
        });
    });

    it('treat an expired suspension as none', () => {
        const expired = row({ suspended: true, until: at(-DAY_MS), kind: 'manual', reason: 'old' });

        expect(noShowSanction(sanctions, expired, ['a', 'b'], NOW)).toMatchObject({
            kind: 'no_show',
            reason: null,
            until: at(7 * DAY_MS),
        });
    });

    it('leave an indefinite suspension alone', () => {
        expect(noShowSanction(sanctions, row({ suspended: true, until: null }), ['a', 'b'], NOW)).toBeNull();
    });

    it('never shorten a running suspension', () => {
        const longer = row({ suspended: true, until: at(20 * DAY_MS), kind: 'no_show' });
        const shorter = row({ suspended: true, until: at(DAY_MS), kind: 'no_show' });

        expect(noShowSanction(sanctions, longer, ['a', 'b'], NOW)?.until).toEqual(at(20 * DAY_MS));
        expect(noShowSanction(sanctions, shorter, ['a', 'b'], NOW)?.until).toEqual(at(7 * DAY_MS));
    });

    it('keep the reason and the author of a running manual suspension', () => {
        const admin = new Types.ObjectId();
        const manual = row({
            suspended: true,
            until: at(DAY_MS),
            kind: 'manual',
            reason: 'Rude',
            suspended_by: admin,
        });

        expect(noShowSanction(sanctions, manual, ['a', 'b'], NOW)).toEqual({
            until: at(7 * DAY_MS),
            kind: 'manual',
            reason: 'Rude',
            booking_ids: [],
            suspended_by: admin,
        });
    });

    it('are lifted by correcting a status only for a no-show they counted', () => {
        const counted = row({ suspended: true, until: at(DAY_MS), kind: 'no_show', booking_ids: ['a', 'b'] });

        expect(liftedByCorrection(counted, 'a', NOW)).toBe(true);
        expect(liftedByCorrection(counted, 'c', NOW)).toBe(false);
        expect(liftedByCorrection({ ...counted, kind: 'manual' }, 'a', NOW)).toBe(false);
        expect(liftedByCorrection({ ...counted, until: at(-MINUTE) }, 'a', NOW)).toBe(false);
        expect(liftedByCorrection(null, 'a', NOW)).toBe(false);
    });
});
