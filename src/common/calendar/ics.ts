const CRLF = '\r\n';
const LINE_OCTETS = 75;

export type CalendarEventStatus = 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';

export interface CalendarEvent {
    uid: string;
    summary: string;
    description?: string;
    location?: string;
    geo?: { lat: number; lng: number };
    starts_at: Date;
    ends_at: Date | null;
    date?: string;
    status: CalendarEventStatus;
    sequence: number;
    updated_at: Date;
}

export interface CalendarOptions {
    name?: string;
    refresh_minutes?: number;
}

export function escapeText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

export function foldLine(line: string): string {
    const parts: string[] = [];
    let current = '';
    let octets = 0;
    let limit = LINE_OCTETS;

    for (const char of line) {
        const size = Buffer.byteLength(char, 'utf8');

        if (octets + size > limit) {
            parts.push(current);
            current = '';
            octets = 0;
            limit = LINE_OCTETS - 1;
        }

        current += char;
        octets += size;
    }

    parts.push(current);

    return parts.join(`${CRLF} `);
}

export function utcStamp(instant: Date): string {
    return instant
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/[-:]/g, '');
}

function dateStamp(date: string): string {
    return date.replace(/-/g, '');
}

function nextDay(date: string): string {
    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);

    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function eventLines(event: CalendarEvent): string[] {
    const timing = event.date
        ? [
              `DTSTART;VALUE=DATE:${dateStamp(event.date)}`,
              `DTEND;VALUE=DATE:${dateStamp(nextDay(event.date))}`,
          ]
        : [
              `DTSTART:${utcStamp(event.starts_at)}`,
              ...(event.ends_at ? [`DTEND:${utcStamp(event.ends_at)}`] : []),
          ];

    return [
        'BEGIN:VEVENT',
        `UID:${escapeText(event.uid)}`,
        `DTSTAMP:${utcStamp(event.updated_at)}`,
        `LAST-MODIFIED:${utcStamp(event.updated_at)}`,
        `SEQUENCE:${event.sequence}`,
        ...timing,
        `SUMMARY:${escapeText(event.summary)}`,
        ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
        ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
        ...(event.geo ? [`GEO:${event.geo.lat};${event.geo.lng}`] : []),
        `STATUS:${event.status}`,
        'END:VEVENT',
    ];
}

export function renderCalendar(events: CalendarEvent[], options: CalendarOptions = {}): string {
    const refresh = options.refresh_minutes ? `PT${options.refresh_minutes}M` : undefined;
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Smart City//Bookings//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        ...(options.name ? [`X-WR-CALNAME:${escapeText(options.name)}`] : []),
        ...(refresh ? [`REFRESH-INTERVAL;VALUE=DURATION:${refresh}`, `X-PUBLISHED-TTL:${refresh}`] : []),
        ...events.flatMap(eventLines),
        'END:VCALENDAR',
    ];

    return lines.map(foldLine).join(CRLF) + CRLF;
}
