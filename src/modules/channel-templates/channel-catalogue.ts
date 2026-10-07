import { texts } from '../../common/i18n/messages';
import { type OutboxEventType } from '../../common/outbox/schemas/outbox-event.schema';

export const CHANNEL_TEMPLATE_KEYS = [
    'booking_created_mail',
    'booking_reminder_mail',
    'booking_reminder_sms',
    'booking_reminder_viber',
    'waitlist_available_mail',
    'waitlist_available_sms',
    'waitlist_available_viber',
    'booking_cancelled_mail',
    'booking_cancelled_sms',
    'booking_cancelled_viber',
    'booking_moved_mail',
    'booking_moved_sms',
    'booking_moved_viber',
    'booking_suspended_mail',
    'booking_suspended_sms',
    'booking_suspended_viber',
    'callback_due_mail',
] as const;
export type ChannelTemplateKey = (typeof CHANNEL_TEMPLATE_KEYS)[number];

export const CHANNELS = ['mail', 'sms', 'viber'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelTemplateDefinition {
    event: OutboxEventType;
    channel: Channel;
    variables: readonly string[];
}

const SLOT = ['service', 'date', 'time', 'end_time'] as const;

export const CHANNEL_TEMPLATES: Record<ChannelTemplateKey, ChannelTemplateDefinition> = {
    booking_created_mail: {
        event: 'booking.created',
        channel: 'mail',
        variables: [...SLOT, 'phone', 'name'],
    },
    booking_reminder_mail: {
        event: 'booking.reminder',
        channel: 'mail',
        variables: [...SLOT, 'code', 'phone', 'calendar'],
    },
    booking_reminder_sms: { event: 'booking.reminder', channel: 'sms', variables: [...SLOT, 'code'] },
    booking_reminder_viber: { event: 'booking.reminder', channel: 'viber', variables: [...SLOT, 'code'] },
    waitlist_available_mail: {
        event: 'waitlist.slot_available',
        channel: 'mail',
        variables: [...SLOT, 'phone'],
    },
    waitlist_available_sms: { event: 'waitlist.slot_available', channel: 'sms', variables: SLOT },
    waitlist_available_viber: { event: 'waitlist.slot_available', channel: 'viber', variables: SLOT },
    booking_cancelled_mail: {
        event: 'booking.cancelled',
        channel: 'mail',
        variables: [...SLOT, 'reason', 'phone'],
    },
    booking_cancelled_sms: { event: 'booking.cancelled', channel: 'sms', variables: [...SLOT, 'reason'] },
    booking_cancelled_viber: {
        event: 'booking.cancelled',
        channel: 'viber',
        variables: [...SLOT, 'reason'],
    },
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
    booking_moved_viber: {
        event: 'booking.rescheduled',
        channel: 'viber',
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
    booking_suspended_viber: {
        event: 'booking.suspended',
        channel: 'viber',
        variables: ['service', 'until', 'missed', 'reason'],
    },
    callback_due_mail: {
        event: 'booking.callback_due',
        channel: 'mail',
        variables: [...SLOT, 'phone', 'name'],
    },
};

export function defaultTemplate(key: ChannelTemplateKey): { subject: string | null; body: string } {
    return texts.channels[key];
}
