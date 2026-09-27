import { type CalendarEvent, escapeText, foldLine, renderCalendar, utcStamp } from './ics';

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
    uid: 'booking-1@city.example.com',
    summary: 'Passport',
    starts_at: new Date('2026-10-01T08:30:00.000Z'),
    ends_at: new Date('2026-10-01T09:00:00.000Z'),
    status: 'CONFIRMED',
    sequence: 0,
    updated_at: new Date('2026-09-20T12:00:00.000Z'),
    ...overrides,
});

const unfold = (text: string): string[] => text.replace(/\r\n /g, '').split('\r\n');

describe('ics', () => {
    it('escapes the characters RFC 5545 reserves in text values', () => {
        expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
    });

    it('folds long lines at 75 octets without splitting a multi-byte character', () => {
        const line = `SUMMARY:${'Ж'.repeat(60)}`;
        const folded = foldLine(line);
        const parts = folded.split('\r\n');

        expect(parts.length).toBeGreaterThan(1);

        for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);

        expect(parts.slice(1).every((part) => part.startsWith(' '))).toBe(true);
        expect(folded.replace(/\r\n /g, '')).toBe(line);
        expect(foldLine('SHORT:1')).toBe('SHORT:1');
    });

    it('renders instants in UTC', () => {
        expect(utcStamp(new Date('2026-10-01T08:30:15.123Z'))).toBe('20261001T083015Z');
    });

    it('renders a timed event with its end, place and status', () => {
        const text = renderCalendar([
            event({
                description: 'City hall',
                location: 'Main st. 1, Berlin',
                geo: { lat: 52.52, lng: 13.405 },
                status: 'TENTATIVE',
                sequence: 3,
            }),
        ]);
        const lines = unfold(text);

        expect(text.endsWith('\r\n')).toBe(true);
        expect(lines[0]).toBe('BEGIN:VCALENDAR');
        expect(lines).toEqual(
            expect.arrayContaining([
                'VERSION:2.0',
                'METHOD:PUBLISH',
                'BEGIN:VEVENT',
                'UID:booking-1@city.example.com',
                'DTSTAMP:20260920T120000Z',
                'SEQUENCE:3',
                'DTSTART:20261001T083000Z',
                'DTEND:20261001T090000Z',
                'SUMMARY:Passport',
                'DESCRIPTION:City hall',
                'LOCATION:Main st. 1\\, Berlin',
                'GEO:52.52;13.405',
                'STATUS:TENTATIVE',
                'END:VEVENT',
                'END:VCALENDAR',
            ]),
        );
    });

    it('renders a dated slot as a whole-day event and leaves out an unknown end', () => {
        const lines = unfold(
            renderCalendar([
                event({ date: '2026-12-31', ends_at: null }),
                event({ uid: 'b-2', ends_at: null }),
            ]),
        );

        expect(lines).toContain('DTSTART;VALUE=DATE:20261231');
        expect(lines).toContain('DTEND;VALUE=DATE:20270101');
        expect(lines.filter((line) => line.startsWith('DTEND'))).toHaveLength(1);
    });

    it('names a subscription feed and tells clients how often to refresh it', () => {
        const lines = unfold(renderCalendar([], { name: 'Bookings', refresh_minutes: 60 }));

        expect(lines).toContain('X-WR-CALNAME:Bookings');
        expect(lines).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT60M');
        expect(lines).toContain('X-PUBLISHED-TTL:PT60M');
        expect(lines).not.toContain('BEGIN:VEVENT');
    });
});
