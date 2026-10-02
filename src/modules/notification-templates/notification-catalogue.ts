import { texts } from '../../common/i18n/messages';
import { type OutboxEventType } from '../../common/outbox/schemas/outbox-event.schema';

export const NOTIFICATION_KEYS = [
    'booking_created_mail',
    'booking_reminder_mail',
    'booking_reminder_sms',
    'waitlist_available_mail',
    'waitlist_available_sms',
    'booking_cancelled_mail',
    'booking_cancelled_sms',
    'booking_moved_mail',
    'booking_moved_sms',
    'booking_suspended_mail',
    'booking_suspended_sms',
    'callback_due_mail',
] as const;
export type NotificationKey = (typeof NOTIFICATION_KEYS)[number];

export const NOTIFICATION_CHANNELS = ['mail', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationDefinition {
    event: OutboxEventType;
    channel: NotificationChannel;
    variables: readonly string[];
}

const SLOT = ['service', 'date', 'time', 'end_time'] as const;

export const NOTIFICATIONS: Record<NotificationKey, NotificationDefinition> = {
    booking_created_mail: {
        event: 'booking.created',
        channel: 'mail',
        variables: [...SLOT, 'phone', 'name'],
    },
    booking_reminder_mail: {
        event: 'booking.reminder',
        channel: 'mail',
        variables: [...SLOT, 'phone', 'calendar'],
    },
    booking_reminder_sms: { event: 'booking.reminder', channel: 'sms', variables: SLOT },
    waitlist_available_mail: {
        event: 'waitlist.slot_available',
        channel: 'mail',
        variables: [...SLOT, 'phone'],
    },
    waitlist_available_sms: { event: 'waitlist.slot_available', channel: 'sms', variables: SLOT },
    booking_cancelled_mail: {
        event: 'booking.cancelled',
        channel: 'mail',
        variables: [...SLOT, 'reason', 'phone'],
    },
    booking_cancelled_sms: { event: 'booking.cancelled', channel: 'sms', variables: [...SLOT, 'reason'] },
    booking_moved_mail: {
        event: 'booking.rescheduled',
        channel: 'mail',
        variables: [...SLOT, 'previous_date', 'previous_time', 'reason', 'phone'],
    },
    booking_moved_sms: {
        event: 'booking.rescheduled',
        channel: 'sms',
        variables: [...SLOT, 'previous_date', 'previous_time', 'reason'],
    },
    booking_suspended_mail: {
        event: 'booking.suspended',
        channel: 'mail',
        variables: ['service', 'until', 'missed', 'reason', 'phone'],
    },
    booking_suspended_sms: {
        event: 'booking.suspended',
        channel: 'sms',
        variables: ['service', 'until', 'missed', 'reason'],
    },
    callback_due_mail: {
        event: 'booking.callback_due',
        channel: 'mail',
        variables: [...SLOT, 'phone', 'name'],
    },
};

export function defaultTemplate(key: NotificationKey): { subject: string | null; body: string } {
    return texts.notifications[key];
}
