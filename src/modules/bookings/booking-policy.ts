import { ApiError } from '../../common/http/api-error';
import { DAY_MS, dateOnlyIn, instantIn, shiftDateOnly } from '../../common/time/zone';
import { type BookingPolicy } from '../services/schemas/service.schema';
import { type BookingSuspension } from './schemas/suspension.schema';

const MINUTE_MS = 60_000;

type Policy = Partial<BookingPolicy> | null | undefined;

type SuspensionState = Pick<BookingSuspension, 'suspended' | 'until'>;

export type SuspensionChange = Pick<
    BookingSuspension,
    'until' | 'kind' | 'reason' | 'booking_ids' | 'suspended_by'
>;

export function assertBookingWindow(policy: Policy, start: Date, now: Date, timeZone: string): void {
    const lead = policy?.lead_time_minutes;

    if (lead !== null && lead !== undefined && start.getTime() - now.getTime() < lead * MINUTE_MS)
        throw ApiError.unprocessable('BOOKING_LEAD_TIME');

    const advance = policy?.max_advance_days;

    if (advance === null || advance === undefined) return;

    const horizon = instantIn(shiftDateOnly(dateOnlyIn(now, timeZone), advance), '23:59', timeZone);

    if (start.getTime() > horizon.getTime()) throw ApiError.unprocessable('BOOKING_TOO_FAR_AHEAD');
}

export function cancelDeadlinePassed(policy: Policy, startsAt: Date | null, now: Date): boolean {
    const deadline = policy?.cancel_deadline_minutes;

    if (deadline === null || deadline === undefined || !startsAt) return false;

    return startsAt.getTime() - now.getTime() < deadline * MINUTE_MS;
}

export function assertCancelDeadline(policy: Policy, startsAt: Date | null, now: Date): void {
    if (cancelDeadlinePassed(policy, startsAt, now))
        throw ApiError.unprocessable('BOOKING_CANCEL_DEADLINE_PASSED');
}

export type CancelTiming = 'on_time' | 'late';

export function resolveCancel(policy: Policy, startsAt: Date | null, now: Date): CancelTiming {
    if (!cancelDeadlinePassed(policy, startsAt, now)) return 'on_time';

    const upcoming = startsAt !== null && startsAt.getTime() > now.getTime();

    if (upcoming && policy?.late_cancel === 'no_show') return 'late';

    throw ApiError.unprocessable('BOOKING_CANCEL_DEADLINE_PASSED');
}

export interface IntervalWindow {
    from: string;
    to: string;
    since: Date;
    until: Date;
}

export function intervalWindow(days: number, date: string, timeZone: string): IntervalWindow {
    const from = shiftDateOnly(date, 1 - days);
    const to = shiftDateOnly(date, days - 1);

    return {
        from,
        to,
        since: instantIn(from, null, timeZone),
        until: instantIn(shiftDateOnly(to, 1), null, timeZone),
    };
}

export function checkInOpen(slotDate: string | null, now: Date, timeZone: string): boolean {
    return slotDate === null || slotDate === dateOnlyIn(now, timeZone);
}

export function noShowCutoffs(minutes: number, now: Date): { timedBefore: Date; untimedBefore: Date } {
    return {
        timedBefore: new Date(now.getTime() - minutes * MINUTE_MS),
        untimedBefore: new Date(now.getTime() - DAY_MS),
    };
}

export function inForce<T extends SuspensionState>(row: T | null, now: Date): row is T {
    return row !== null && row.suspended && (row.until === null || row.until.getTime() > now.getTime());
}

export function manualSuspensionEnd(days: number | null | undefined, now: Date): Date | null {
    return days ? new Date(now.getTime() + days * DAY_MS) : null;
}

export function noShowEnabled(policy: Policy): boolean {
    return (policy?.no_show_limit ?? null) !== null && (policy?.no_show_suspension_days ?? null) !== null;
}

export function noShowCountedSince(countedFrom: Date | null | undefined, policy: Policy, now: Date): Date {
    const window = policy?.no_show_window_days ?? null;

    return new Date(
        Math.max(countedFrom?.getTime() ?? 0, window === null ? 0 : now.getTime() - window * DAY_MS),
    );
}

export function noShowSanction(
    policy: Policy,
    row: SuspensionState & Pick<BookingSuspension, 'kind' | 'reason' | 'suspended_by'>,
    missed: string[],
    now: Date,
): SuspensionChange | null {
    const limit = policy?.no_show_limit ?? null;
    const days = policy?.no_show_suspension_days ?? null;

    if (limit === null || days === null || missed.length < limit) return null;

    const active = inForce(row, now);

    if (active && row.until === null) return null;

    const until = new Date(Math.max(now.getTime() + days * DAY_MS, active ? (row.until?.getTime() ?? 0) : 0));

    return active && row.kind === 'manual'
        ? { until, kind: row.kind, reason: row.reason, booking_ids: [], suspended_by: row.suspended_by }
        : { until, kind: 'no_show', reason: null, booking_ids: missed, suspended_by: null };
}

export function liftedByCorrection<
    T extends SuspensionState & Pick<BookingSuspension, 'kind' | 'booking_ids'>,
>(row: T | null, bookingId: string, now: Date): row is T {
    return inForce(row, now) && row.kind === 'no_show' && row.booking_ids.includes(bookingId);
}
