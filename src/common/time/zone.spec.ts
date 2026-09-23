import {
    dateOnlyIn,
    instantIn,
    isSupportedTimeZone,
    isoAtIn,
    isoIn,
    offsetLabel,
    offsetMinutesIn,
    shiftDateOnly,
    timeOfDayIn,
    weekdayOfDateOnly,
} from './zone';

describe('zone', () => {
    it('accepts IANA names and rejects anything else', () => {
        expect(isSupportedTimeZone('Europe/Berlin')).toBe(true);
        expect(isSupportedTimeZone('UTC')).toBe(true);
        expect(isSupportedTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
        expect(isSupportedTimeZone('Mars/Olympus')).toBe(false);
        expect(isSupportedTimeZone('+02:00')).toBe(false);
        expect(isSupportedTimeZone('')).toBe(false);
    });

    it('reads the calendar day of a zone, not of the process', () => {
        const instant = new Date('2026-01-05T23:30:00Z');

        expect(dateOnlyIn(instant, 'UTC')).toBe('2026-01-05');
        expect(dateOnlyIn(instant, 'Europe/Berlin')).toBe('2026-01-06');
        expect(dateOnlyIn(instant, 'America/New_York')).toBe('2026-01-05');
        expect(timeOfDayIn(instant, 'Europe/Berlin')).toBe('00:30');
    });

    it('resolves a wall clock to the instant that zone names', () => {
        expect(instantIn('2026-01-15', '09:00', 'Europe/Berlin').toISOString()).toBe(
            '2026-01-15T08:00:00.000Z',
        );
        expect(instantIn('2026-07-15', '09:00', 'Europe/Berlin').toISOString()).toBe(
            '2026-07-15T07:00:00.000Z',
        );
        expect(instantIn('2026-01-15', null, 'Europe/Berlin').toISOString()).toBe('2026-01-14T23:00:00.000Z');
    });

    it('crosses a DST boundary without drifting an hour', () => {
        expect(offsetMinutesIn(new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin')).toBe(60);
        expect(offsetMinutesIn(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin')).toBe(120);
        expect(instantIn('2026-03-29', '04:00', 'Europe/Berlin').toISOString()).toBe(
            '2026-03-29T02:00:00.000Z',
        );
    });

    it('resolves a wall clock that DST skipped to the moment the clock jumped', () => {
        const skipped = instantIn('2026-03-29', '02:30', 'Europe/Berlin');

        expect(skipped.toISOString()).toBe('2026-03-29T01:30:00.000Z');
        expect(timeOfDayIn(skipped, 'Europe/Berlin')).toBe('03:30');
    });

    it('labels offsets the way ISO 8601 writes them', () => {
        expect(offsetLabel(0)).toBe('Z');
        expect(offsetLabel(120)).toBe('+02:00');
        expect(offsetLabel(330)).toBe('+05:30');
        expect(offsetLabel(-300)).toBe('-05:00');
        expect(offsetLabel(-210)).toBe('-03:30');
    });

    it('builds an ISO string whose offset matches its own wall clock', () => {
        expect(isoIn('2026-01-15', '09:00', 'Europe/Berlin')).toBe('2026-01-15T09:00:00+01:00');
        expect(isoIn('2026-07-15', '09:00', 'Europe/Berlin')).toBe('2026-07-15T09:00:00+02:00');
        expect(isoIn('2026-07-15', '09:00', 'UTC')).toBe('2026-07-15T09:00:00Z');
        expect(isoIn('2026-01-15', null, 'Asia/Kolkata')).toBe('2026-01-15T00:00:00+05:30');
        expect(isoIn('2026-03-29', '02:30', 'Europe/Berlin')).toBe('2026-03-29T03:30:00+02:00');
    });

    it('renders an instant with the offset of a zone', () => {
        expect(isoAtIn(new Date('2026-01-15T08:00:00Z'), 'Europe/Berlin')).toBe('2026-01-15T09:00:00+01:00');
        expect(isoAtIn(new Date('2026-07-15T07:00:00Z'), 'Europe/Berlin')).toBe('2026-07-15T09:00:00+02:00');
        expect(isoAtIn(new Date('2026-09-22T14:59:00Z'), 'Asia/Tokyo')).toBe('2026-09-22T23:59:00+09:00');
        expect(isoAtIn(new Date('2026-09-22T15:29:00Z'), 'Asia/Tokyo')).toBe('2026-09-23T00:29:00+09:00');
        expect(isoAtIn(new Date('2026-07-15T09:00:00Z'), 'UTC')).toBe('2026-07-15T09:00:00Z');
    });

    it('shifts date-only strings over month, year and DST boundaries', () => {
        expect(shiftDateOnly('2026-01-31', 1)).toBe('2026-02-01');
        expect(shiftDateOnly('2026-03-01', -1)).toBe('2026-02-28');
        expect(shiftDateOnly('2026-12-31', 1)).toBe('2027-01-01');
        expect(shiftDateOnly('2026-03-28', 1)).toBe('2026-03-29');
        expect(shiftDateOnly('2026-01-05', 30)).toBe('2026-02-04');
        expect(shiftDateOnly('2026-01-05', 0)).toBe('2026-01-05');
    });

    it('reads the weekday of a date-only string', () => {
        expect(weekdayOfDateOnly('2026-01-05')).toBe(1);
        expect(weekdayOfDateOnly('2026-01-11')).toBe(0);
    });
});
