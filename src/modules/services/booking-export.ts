import { CSV_BOM, csvLine, type CsvValue } from '../../common/csv';
import { type BookingEntity } from '../bookings/bookings.repository';

const COLUMNS: readonly [string, (booking: BookingEntity) => CsvValue][] = [
    ['id', (booking) => booking.id],
    ['status', (booking) => booking.status],
    ['service_id', (booking) => booking.service_id.toHexString()],
    ['service_label', (booking) => booking.service_label],
    ['organization_id', (booking) => booking.organization_id.toHexString()],
    ['option_id', (booking) => booking.option_id],
    ['slot_id', (booking) => booking.slot_id],
    ['child_type', (booking) => booking.child_type],
    ['date', (booking) => booking.slot_date],
    ['time', (booking) => booking.slot_time],
    ['end_time', (booking) => booking.slot_end],
    ['starts_at', (booking) => booking.starts_at],
    ['ends_at', (booking) => booking.ends_at],
    ['user_id', (booking) => booking.user_id.toHexString()],
    ['person', (booking) => booking.person],
    ['phone', (booking) => booking.phone],
    ['address', (booking) => booking.address],
    ['info', (booking) => booking.info],
    ['fields', (booking) => (Object.keys(booking.fields ?? {}).length ? booking.fields : null)],
    ['documents', (booking) => (booking.documents ?? []).join('; ')],
    ['created_at', (booking) => booking.created_at],
    ['confirmed_at', (booking) => booking.confirmed_at],
    ['finished_at', (booking) => booking.finished_at],
];

export async function* bookingsCsv(bookings: AsyncIterable<BookingEntity>): AsyncGenerator<string> {
    yield CSV_BOM + csvLine(COLUMNS.map(([name]) => name));

    for await (const booking of bookings) yield csvLine(COLUMNS.map(([, value]) => value(booking)));
}
