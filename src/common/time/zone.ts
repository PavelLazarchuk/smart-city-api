const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

interface ZonedParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    const cached = formatters.get(timeZone);

    if (cached) return cached;

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    formatters.set(timeZone, formatter);

    return formatter;
}

export function isSupportedTimeZone(timeZone: string): boolean {
    if (!IANA_NAME.test(timeZone)) return false;

    try {
        formatterFor(timeZone);

        return true;
    } catch {
        return false;
    }
}

function partsIn(instant: Date, timeZone: string): ZonedParts {
    const parts = formatterFor(timeZone).formatToParts(instant);
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);

    return {
        year: read('year'),
        month: read('month'),
        day: read('day'),
        hour: read('hour'),
        minute: read('minute'),
        second: read('second'),
    };
}

function pad(value: number, width = 2): string {
    return String(Math.abs(value)).padStart(width, '0');
}

export function offsetMinutesIn(instant: Date, timeZone: string): number {
    const parts = partsIn(instant, timeZone);
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

    return Math.round((wall - (instant.getTime() - instant.getMilliseconds())) / 60_000);
}

export function offsetLabel(minutes: number): string {
    if (minutes === 0) return 'Z';

    const sign = minutes < 0 ? '-' : '+';

    return `${sign}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

export function dateOnlyIn(instant: Date, timeZone: string): string {
    const parts = partsIn(instant, timeZone);

    return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function timeOfDayIn(instant: Date, timeZone: string): string {
    const parts = partsIn(instant, timeZone);

    return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function instantIn(date: string, time: string | null | undefined, timeZone: string): Date {
    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
    const [hours = 0, minutes = 0] = (time ?? '00:00').split(':').map(Number);
    const wall = Date.UTC(year, month - 1, day, hours, minutes);
    const first = wall - offsetMinutesIn(new Date(wall), timeZone) * 60_000;

    return new Date(wall - offsetMinutesIn(new Date(first), timeZone) * 60_000);
}

export function isoIn(date: string, time: string | null | undefined, timeZone: string): string {
    return isoAtIn(instantIn(date, time, timeZone), timeZone);
}

export function isoAtIn(instant: Date, timeZone: string): string {
    const parts = partsIn(instant, timeZone);
    const label = offsetLabel(offsetMinutesIn(instant, timeZone));

    return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${label}`;
}

export function shiftDateOnly(date: string, days: number): string {
    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, day + days));

    return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function weekdayOfDateOnly(date: string): number {
    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);

    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
