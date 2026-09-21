import { type OutboxEventEntity } from '../../common/outbox/outbox.repository';
import { type BookingEntity } from '../bookings/bookings.repository';
import { type Booking } from '../bookings/schemas/booking.schema';

export function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function optional(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

export function eventPayload(
    booking: BookingEntity | Booking,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        booking_id: booking.id,
        service_id: booking.service_id.toHexString(),
        organization_id: booking.organization_id.toHexString(),
        option_id: booking.option_id,
        slot_id: booking.slot_id,
        child_type: booking.child_type,
        date: booking.slot_date,
        time: booking.slot_time,
        user_id: booking.user_id.toHexString(),
        status: booking.status,
        service_label: booking.service_label,
        ...extra,
    };
}

export interface BookingNotice {
    service: string;
    date?: string;
    time?: string;
    reason?: string;
    phone: string;
}

export function notice(event: OutboxEventEntity): BookingNotice {
    return {
        service: text(event.payload['service_label']),
        date: optional(event.payload['date']),
        time: optional(event.payload['time']),
        reason: optional(event.payload['reason']),
        phone: text(event.internal?.['phone']),
    };
}

export function previousOf(event: OutboxEventEntity): {
    previous_date?: string;
    previous_time?: string;
} {
    const previous = (event.payload['previous'] ?? {}) as Record<string, unknown>;

    return { previous_date: optional(previous['date']), previous_time: optional(previous['time']) };
}

export function announced(event: OutboxEventEntity): boolean {
    return event.internal?.['notify'] === true;
}

export function recipientEmail(event: OutboxEventEntity): string {
    return text(event.internal?.['email']);
}
