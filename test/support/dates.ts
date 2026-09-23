export const FIXTURE_TIME_ZONE = process.env['JOBS_TIMEZONE'] ?? 'UTC';

export function dateOnlyIn(instant: Date, timeZone = FIXTURE_TIME_ZONE): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(instant);
}

export function shiftDateOnly(date: string, days: number): string {
    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);

    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function dateOnly(offsetDays: number, timeZone = FIXTURE_TIME_ZONE): string {
    return shiftDateOnly(dateOnlyIn(new Date(), timeZone), offsetDays);
}
