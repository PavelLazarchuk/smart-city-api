import { texts } from '../../common/i18n/messages';
import { renderTemplate, type TemplateData } from '../../common/i18n/template';
import { type OutboxEventType } from '../../common/outbox/schemas/outbox-event.schema';
import { type EventActor } from '../bookings/booking-events';

export const NOTIFICATION_AUDIENCES = ['client', 'staff'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_STATUSES = ['unread', 'read'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const CLIENT_NOTIFICATION_TYPES = [
    'booking_cancelled',
    'booking_rejected',
    'slot_cancelled',
    'booking_rescheduled',
    'slot_moved',
    'booking_confirmed',
    'booking_created_for_you',
    'booking_reminder',
    'waitlist_slot_available',
    'booking_suspended',
    'booking_suspension_lifted',
    'organization_message',
] as const;

export const STAFF_NOTIFICATION_TYPES = [
    'client_booked',
    'client_cancelled',
    'client_rescheduled',
    'callback_due',
    'client_suspended',
] as const;

export const NOTIFICATION_TYPES = [...CLIENT_NOTIFICATION_TYPES, ...STAFF_NOTIFICATION_TYPES] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const INBOX_EVENTS: readonly OutboxEventType[] = [
    'booking.created',
    'booking.cancelled',
    'booking.rescheduled',
    'booking.status_changed',
    'booking.reminder',
    'booking.callback_due',
    'waitlist.slot_available',
    'booking.suspended',
    'booking.suspension_lifted',
];

const WHEN = ['service', 'date', 'time', 'organization'] as const;
const MOVE = [...WHEN, 'previous_date', 'previous_time', 'reason'] as const;
const CLIENT = ['name', 'phone'] as const;

export const INBOX_VARIABLES: Record<NotificationType, readonly string[]> = {
    booking_cancelled: [...WHEN, 'reason'],
    booking_rejected: [...WHEN, 'reason'],
    slot_cancelled: [...WHEN, 'reason'],
    booking_rescheduled: MOVE,
    slot_moved: MOVE,
    booking_confirmed: WHEN,
    booking_created_for_you: WHEN,
    booking_reminder: WHEN,
    waitlist_slot_available: WHEN,
    booking_suspended: ['service', 'organization', 'missed', 'until', 'reason'],
    booking_suspension_lifted: ['service', 'organization'],
    organization_message: ['organization', 'body'],
    client_booked: [...WHEN, ...CLIENT, 'requires_action'],
    client_cancelled: [...WHEN, ...CLIENT],
    client_rescheduled: [...MOVE, ...CLIENT],
    callback_due: [...WHEN, 'end_time', ...CLIENT],
    client_suspended: ['service', 'missed', 'until', ...CLIENT],
};

export interface InboxEvent {
    type: OutboxEventType;
    payload: Record<string, unknown>;
    internal: Record<string, unknown> | null;
}

export interface NotificationRule {
    audience: NotificationAudience;
    type: NotificationType;
}

export interface NotificationData {
    booking_id?: string;
    service_id?: string;
    option_id?: string;
    slot_id?: string;
    service_label?: string;
    date?: string;
    time?: string;
    end_time?: string;
    previous_date?: string;
    previous_time?: string;
    reason?: string;
    until?: string;
    missed?: number;
    requires_action?: boolean;
    client_name?: string;
    client_phone?: string;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

const client = (type: NotificationType): NotificationRule => ({ audience: 'client', type });
const staff = (type: NotificationType): NotificationRule => ({ audience: 'staff', type });

export function actorOf(event: InboxEvent): EventActor | null {
    const actor = record(event.internal?.['actor']);
    const id = text(actor['id']);
    const kind = actor['kind'];

    return id && (kind === 'client' || kind === 'staff') ? { id, kind } : null;
}

function cancelledBy(event: InboxEvent): EventActor['kind'] | null {
    const actor = actorOf(event);

    if (actor) return actor.kind;

    if (event.payload['cancelled_by'] === 'owner') return 'client';

    if (event.payload['cancelled_by'] === 'admin') return 'staff';

    return null;
}

export function notificationsFor(event: InboxEvent): NotificationRule[] {
    const actor = actorOf(event);
    const bulk = event.payload['bulk'] === true;

    switch (event.type) {
        case 'booking.created':
            if (actor?.kind === 'staff') return [client('booking_created_for_you')];

            return actor?.kind === 'client' ? [staff('client_booked')] : [];
        case 'booking.cancelled': {
            if (bulk) return [client('slot_cancelled')];

            const by = cancelledBy(event);

            if (by === 'client') return [staff('client_cancelled')];

            if (by !== 'staff') return [];

            return [
                client(
                    event.payload['previous_status'] === 'pending' ? 'booking_rejected' : 'booking_cancelled',
                ),
            ];
        }
        case 'booking.rescheduled':
            if (bulk) return [client('slot_moved')];

            if (actor?.kind === 'client') return [staff('client_rescheduled')];

            return actor?.kind === 'staff' ? [client('booking_rescheduled')] : [];
        case 'booking.status_changed':
            return actor?.kind === 'staff' &&
                event.payload['previous_status'] === 'pending' &&
                event.payload['status'] === 'confirmed'
                ? [client('booking_confirmed')]
                : [];
        case 'booking.reminder':
            return [client('booking_reminder')];
        case 'booking.callback_due':
            return [staff('callback_due')];
        case 'waitlist.slot_available':
            return [client('waitlist_slot_available')];
        case 'booking.suspended':
            return actor || event.payload['kind'] !== 'no_show'
                ? [client('booking_suspended')]
                : [client('booking_suspended'), staff('client_suspended')];
        case 'booking.suspension_lifted':
            return [client('booking_suspension_lifted')];
        default:
            return [];
    }
}

function missedOf(payload: Record<string, unknown>): number | undefined {
    const bookings = payload['booking_ids'];

    return payload['kind'] === 'no_show' && Array.isArray(bookings) && bookings.length > 0
        ? bookings.length
        : undefined;
}

function compact<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function notificationData(event: InboxEvent, rule: NotificationRule): NotificationData {
    const { payload } = event;
    const previous = record(payload['previous']);
    const internal = event.internal ?? {};

    return compact({
        booking_id: text(payload['booking_id']),
        service_id: text(payload['service_id']),
        option_id: text(payload['option_id']),
        slot_id: text(payload['slot_id']),
        service_label: text(payload['service_label']),
        date: text(payload['date']),
        time: text(payload['time']),
        end_time: text(payload['end_time']),
        previous_date: text(previous['date']),
        previous_time: text(previous['time']),
        reason: text(payload['reason']),
        until: text(payload['until']),
        missed: missedOf(payload),
        requires_action: rule.type === 'client_booked' ? payload['status'] === 'pending' : undefined,
        client_name: rule.audience === 'staff' ? text(internal['person']) : undefined,
        client_phone: rule.audience === 'staff' ? text(internal['phone']) : undefined,
    });
}

export function templateData(data: NotificationData, organization: string, until?: string): TemplateData {
    return {
        service: data.service_label,
        date: data.date,
        time: data.time,
        end_time: data.end_time,
        previous_date: data.previous_date,
        previous_time: data.previous_time,
        reason: data.reason,
        until: until ?? data.until,
        missed: data.missed,
        requires_action: data.requires_action,
        name: data.client_name,
        phone: data.client_phone,
        organization,
    };
}

export function renderInbox(type: NotificationType, data: TemplateData): { title: string; body: string } {
    const variables = INBOX_VARIABLES[type];
    const template = texts.inbox[type];

    return {
        title: renderTemplate(template.title, variables, data).replace(/\s+/g, ' '),
        body: renderTemplate(template.body, variables, data),
    };
}
