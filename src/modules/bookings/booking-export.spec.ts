import { ObjectId } from 'mongodb';

import { type BookingEntity } from './bookings.repository';
import { bookingsCsv } from './booking-export';

function from<T>(items: T[]): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]: () => {
            const iterator = items[Symbol.iterator]();

            return { next: () => Promise.resolve(iterator.next()) };
        },
    };
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
    const lines: string[] = [];

    for await (const chunk of chunks) lines.push(chunk);

    return lines;
}

describe('bookingsCsv', () => {
    it('yields only the header with a BOM when there are no bookings', async () => {
        const chunks = await collect(bookingsCsv(from([])));

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.startsWith('﻿id,status,service_id,')).toBe(true);
        expect(chunks[0]?.endsWith('\r\n')).toBe(true);
    });

    it('yields one line per booking, neutralizing formulas and joining documents', async () => {
        const booking = {
            id: 'b1',
            status: 'confirmed',
            service_id: new ObjectId(),
            service_label: '=SUM(A1)',
            organization_id: new ObjectId(),
            user_id: new ObjectId(),
            documents: ['a.pdf', 'b.pdf'],
            fields: {},
            created_at: new Date('2026-10-03T10:00:00.000Z'),
        } as unknown as BookingEntity;

        const chunks = await collect(bookingsCsv(from([booking])));

        expect(chunks).toHaveLength(2);

        const line = chunks[1] ?? '';

        expect(line.startsWith('b1,confirmed,')).toBe(true);
        expect(line).not.toContain(',=SUM(A1)');
        expect(line).toContain('a.pdf; b.pdf');
        expect(line).toContain('2026-10-03T10:00:00.000Z');
        expect(line.endsWith('\r\n')).toBe(true);
    });
});
