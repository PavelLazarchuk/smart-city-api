import { Types } from 'mongoose';

import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { type OutboxEventEntity } from '../../common/outbox/outbox.repository';
import {
    announced,
    eventActor,
    eventPayload,
    notice,
    organizationOf,
    previousOf,
    recipientEmail,
    text,
} from './booking-events';
import { type BookingEntity } from './bookings.repository';

const event = (
    payload: Record<string, unknown>,
    internal: Record<string, unknown> | null = null,
    organizationId: Types.ObjectId | null = null,
): OutboxEventEntity => ({ payload, internal, organization_id: organizationId }) as OutboxEventEntity;

describe('booking events', () => {
    it('reads only strings as text', () => {
        expect(text('a')).toBe('a');
        expect(text(1)).toBe('');
        expect(text(null)).toBe('');
        expect(text(undefined)).toBe('');
    });

    it('tells the client acting on their own booking from the staff', () => {
        const owner = new Types.ObjectId();

        expect(eventActor({ id: owner.toHexString() } as AuthUser, { user_id: owner })).toEqual({
            id: owner.toHexString(),
            kind: 'client',
        });
        expect(eventActor({ id: 'admin' } as AuthUser, { user_id: owner })).toEqual({
            id: 'admin',
            kind: 'staff',
        });
    });

    it('puts the coordinates of a booking into the payload and never the person', () => {
        const booking = {
            id: 'b1',
            service_id: new Types.ObjectId(),
            organization_id: new Types.ObjectId(),
            option_id: 'o1',
            slot_id: 's1',
            child_type: 'date_time',
            slot_date: '2026-10-12',
            slot_time: '09:00',
            slot_end: undefined,
            user_id: new Types.ObjectId(),
            status: 'confirmed',
            service_label: 'Massage',
            person: 'Anna',
            phone: '380501234567',
        } as unknown as BookingEntity;

        const payload = eventPayload(booking, { reason: 'Ill.' });

        expect(payload).toEqual({
            booking_id: 'b1',
            service_id: booking.service_id.toHexString(),
            organization_id: booking.organization_id.toHexString(),
            option_id: 'o1',
            slot_id: 's1',
            child_type: 'date_time',
            date: '2026-10-12',
            time: '09:00',
            end_time: null,
            user_id: booking.user_id.toHexString(),
            status: 'confirmed',
            service_label: 'Massage',
            reason: 'Ill.',
        });
        expect(JSON.stringify(payload)).not.toMatch(/Anna|380501234567/);
    });

    it('builds the notice from the payload and the phone from the internal part', () => {
        expect(
            notice(
                event(
                    { service_label: 'Massage', date: '2026-10-12', time: '', end_time: 5, reason: 'Ill.' },
                    { phone: '380501234567' },
                ),
            ),
        ).toEqual({
            service: 'Massage',
            date: '2026-10-12',
            time: undefined,
            end_time: undefined,
            reason: 'Ill.',
            phone: '380501234567',
        });
        expect(notice(event({}))).toMatchObject({ service: '', phone: '' });
    });

    it('reads the previous date and time when there are any', () => {
        expect(previousOf(event({ previous: { date: '2026-10-11', time: '09:00' } }))).toEqual({
            previous_date: '2026-10-11',
            previous_time: '09:00',
        });
        expect(previousOf(event({ previous: null }))).toEqual({
            previous_date: undefined,
            previous_time: undefined,
        });
        expect(previousOf(event({}))).toEqual({ previous_date: undefined, previous_time: undefined });
    });

    it('announces only an event explicitly marked so', () => {
        expect(announced(event({}, { notify: true }))).toBe(true);
        expect(announced(event({}, { notify: 'true' }))).toBe(false);
        expect(announced(event({}, null))).toBe(false);
    });

    it('takes the recipient e-mail from the internal part only', () => {
        expect(recipientEmail(event({ email: 'leak@b.c' }, { email: 'a@b.c' }))).toBe('a@b.c');
        expect(recipientEmail(event({ email: 'leak@b.c' }))).toBe('');
    });

    it('prefers the event organization over the one in the payload', () => {
        const organization = new Types.ObjectId();

        expect(organizationOf(event({ organization_id: 'other' }, null, organization))).toBe(
            organization.toHexString(),
        );
        expect(organizationOf(event({ organization_id: 'from-payload' }))).toBe('from-payload');
        expect(organizationOf(event({ organization_id: '' }))).toBeNull();
        expect(organizationOf(event({}))).toBeNull();
    });
});
