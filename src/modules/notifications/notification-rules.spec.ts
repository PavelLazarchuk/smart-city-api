import { texts } from '../../common/i18n/messages';
import { compileTemplate } from '../../common/i18n/template';
import { type OutboxEventType } from '../../common/outbox/schemas/outbox-event.schema';
import {
    INBOX_VARIABLES,
    type InboxEvent,
    NOTIFICATION_TYPES,
    notificationData,
    notificationsFor,
    renderInbox,
    templateData,
} from './notification-rules';

const CLIENT = { id: 'client', kind: 'client' } as const;
const STAFF = { id: 'staff', kind: 'staff' } as const;

function event(
    type: OutboxEventType,
    payload: Record<string, unknown> = {},
    internal: Record<string, unknown> | null = null,
): InboxEvent {
    return { type, payload, internal };
}

const by = (actor: typeof CLIENT | typeof STAFF) => ({ actor });

describe('notification rules', () => {
    it.each([
        ['booking.created', {}, by(CLIENT), [['staff', 'client_booked']]],
        ['booking.created', {}, by(STAFF), [['client', 'booking_created_for_you']]],
        ['booking.created', {}, null, []],
        ['booking.cancelled', { cancelled_by: 'owner' }, by(CLIENT), [['staff', 'client_cancelled']]],
        ['booking.cancelled', { cancelled_by: 'admin' }, by(STAFF), [['client', 'booking_cancelled']]],
        [
            'booking.cancelled',
            { cancelled_by: 'admin', previous_status: 'pending' },
            by(STAFF),
            [['client', 'booking_rejected']],
        ],
        ['booking.cancelled', { cancelled_by: 'admin' }, null, [['client', 'booking_cancelled']]],
        ['booking.cancelled', { cancelled_by: 'owner' }, null, [['staff', 'client_cancelled']]],
        [
            'booking.cancelled',
            { bulk: true, cancelled_by: 'admin' },
            by(STAFF),
            [['client', 'slot_cancelled']],
        ],
        ['booking.cancelled', { bulk: true }, { actor: STAFF, notify: true }, [['client', 'slot_cancelled']]],
        ['booking.rescheduled', {}, by(CLIENT), [['staff', 'client_rescheduled']]],
        ['booking.rescheduled', {}, by(STAFF), [['client', 'booking_rescheduled']]],
        ['booking.rescheduled', { bulk: true }, by(STAFF), [['client', 'slot_moved']]],
        ['booking.rescheduled', {}, null, []],
        [
            'booking.status_changed',
            { previous_status: 'pending', status: 'confirmed' },
            by(STAFF),
            [['client', 'booking_confirmed']],
        ],
        ['booking.status_changed', { previous_status: 'pending', status: 'confirmed' }, by(CLIENT), []],
        ['booking.status_changed', { previous_status: 'confirmed', status: 'no_show' }, by(STAFF), []],
        ['booking.reminder', {}, null, [['client', 'booking_reminder']]],
        ['booking.callback_due', {}, null, [['staff', 'callback_due']]],
        ['waitlist.slot_available', {}, null, [['client', 'waitlist_slot_available']]],
        [
            'booking.suspended',
            { kind: 'no_show' },
            null,
            [
                ['client', 'booking_suspended'],
                ['staff', 'client_suspended'],
            ],
        ],
        ['booking.suspended', { kind: 'manual' }, by(STAFF), [['client', 'booking_suspended']]],
        ['booking.suspended', { kind: 'manual' }, null, [['client', 'booking_suspended']]],
        ['booking.suspension_lifted', {}, by(STAFF), [['client', 'booking_suspension_lifted']]],
        ['webhook.test', {}, null, []],
    ] as const)('%s %j by %j', (type, payload, internal, expected) => {
        expect(
            notificationsFor(event(type, payload, internal)).map((rule) => [rule.audience, rule.type]),
        ).toEqual(expected);
    });

    it('ignores a malformed actor', () => {
        expect(notificationsFor(event('booking.created', {}, { actor: { id: 'x', kind: 'admin' } }))).toEqual(
            [],
        );
    });

    it('keeps the client contact for staff only and whitelists the rest', () => {
        const source = event(
            'booking.rescheduled',
            {
                booking_id: 'b',
                service_label: 'Massage',
                date: '2026-10-12',
                time: '14:00',
                previous: { date: '2026-10-11', time: '09:00' },
                user_id: 'u',
                secret: 'x',
            },
            { actor: CLIENT, person: 'Anna', phone: '380501234567', email: 'a@b.c' },
        );

        expect(notificationData(source, { audience: 'staff', type: 'client_rescheduled' })).toEqual({
            booking_id: 'b',
            service_label: 'Massage',
            date: '2026-10-12',
            time: '14:00',
            previous_date: '2026-10-11',
            previous_time: '09:00',
            client_name: 'Anna',
            client_phone: '380501234567',
        });
        expect(
            notificationData(source, { audience: 'client', type: 'booking_rescheduled' }),
        ).not.toHaveProperty('client_phone');
    });

    it('marks a booking that waits for confirmation and counts missed visits', () => {
        expect(
            notificationData(event('booking.created', { status: 'pending' }), {
                audience: 'staff',
                type: 'client_booked',
            }),
        ).toMatchObject({ requires_action: true });
        expect(
            notificationData(event('booking.suspended', { kind: 'no_show', booking_ids: ['a', 'b'] }), {
                audience: 'client',
                type: 'booking_suspended',
            }),
        ).toMatchObject({ missed: 2 });
    });

    it.each(NOTIFICATION_TYPES)('%s has a text that uses only its own variables', (type) => {
        const template = texts.inbox[type];

        expect(() => compileTemplate(template.title, INBOX_VARIABLES[type])).not.toThrow();
        expect(() => compileTemplate(template.body, INBOX_VARIABLES[type])).not.toThrow();

        const rendered = renderInbox(type, {
            ...templateData(
                {
                    service_label: 'Massage',
                    date: '2026-10-12',
                    time: '14:00',
                    previous_date: '2026-10-11',
                    reason: 'The specialist is ill.',
                    missed: 3,
                    client_name: 'Anna',
                    client_phone: '380501234567',
                },
                'City Clinic',
                '2026-11-01',
            ),
            body: 'Hello',
        });

        expect(rendered.title).not.toBe('');
        expect(rendered.body).not.toBe('');
        expect(rendered.title).not.toContain('{{');
        expect(rendered.body).not.toContain('{{');
    });

    it('renders the organization and the reason into the client text', () => {
        expect(
            renderInbox(
                'booking_cancelled',
                templateData(
                    { service_label: 'Massage', date: '2026-10-12', time: '14:00', reason: 'Ill.' },
                    'City Clinic',
                ),
            ),
        ).toEqual({
            title: 'Booking cancelled',
            body: 'City Clinic cancelled Massage on 2026-10-12 at 14:00. Reason: Ill.',
        });
    });
});
