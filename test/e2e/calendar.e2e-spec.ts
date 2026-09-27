import { Types } from 'mongoose';

import { utcStamp } from '../../src/common/calendar/ics';
import { CALENDAR_FEED } from '../../src/common/config/constants';
import { instantIn } from '../../src/common/time/zone';
import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { type MailMessage } from '../../src/integrations/mail/mail.provider';
import { BookingRemindersJob } from '../../src/jobs/booking-reminders.job';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const ZONE = 'Europe/Berlin';

const unfold = (text: string): string[] => text.replace(/\r\n /g, '').split('\r\n');

describe('bookings in a calendar (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let client: FixtureUser;
    let bearer: string;
    let option: ReturnType<Fixtures['bookableOption']>;
    let serviceId: string;
    let date: string;

    const book = async (time = '10:00') => {
        const res = await t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time });
        expect(res.status).toBe(201);

        return res.body.data.booking_id as string;
    };

    const ics = (bookingId: string, token = bearer) =>
        t.http.get(`${t.prefix}/bookings/${bookingId}/calendar.ics`).set('Authorization', token);

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization({
            main_label: 'City Hall',
            timezone: ZONE,
            address: 'Main st. 1, Berlin',
            location: { type: 'Point', coordinates: [13.405, 52.52] },
        });
        client = await fx.client({ name: 'Anna', phone: '4915291234567' });
        bearer = await fx.bearer(client);
        option = fx.bookableOption(3);
        option.slots[0]!.value.time!.push({ time: '11:00', limit: 3, booked_count: 0 });
        date = option.slots[0]!.value.date!;
        serviceId = (
            await fx.service(organization.id, {
                options: [option],
                duration_minutes: 30,
                value: { heading_value: 'Passport' },
            })
        ).id;
    });

    describe('GET /bookings/:id/calendar.ics', () => {
        it('gives the owner an event in UTC with the service length and the organization address', async () => {
            const id = await book();
            const res = await ics(id);

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
            expect(res.headers['content-disposition']).toBe('attachment; filename="booking.ics"');
            expect(res.headers['cache-control']).toBe('private, no-store, max-age=0');

            const start = instantIn(date, '10:00', ZONE);
            const lines = unfold(res.text);
            expect(lines).toEqual(
                expect.arrayContaining([
                    `UID:booking-${id}@city.example.com`,
                    `DTSTART:${utcStamp(start)}`,
                    `DTEND:${utcStamp(new Date(start.getTime() + 30 * 60_000))}`,
                    'SUMMARY:Passport',
                    'DESCRIPTION:City Hall',
                    'LOCATION:Main st. 1\\, Berlin',
                    'GEO:52.52;13.405',
                    'STATUS:CONFIRMED',
                ]),
            );
        });

        it('serves the organization admins and nobody else', async () => {
            const id = await book();
            const admin = await fx.bearer(await fx.admin([organization.id]));
            const stranger = await fx.bearer(await fx.client());

            expect((await ics(id, admin)).status).toBe(200);
            expectError(await ics(id, stranger), 404, 'BOOKING_NOT_FOUND');
            expectError(await ics('00000000-0000-4000-8000-000000000000'), 404, 'BOOKING_NOT_FOUND');
            expectError(await t.http.get(`${t.prefix}/bookings/${id}/calendar.ics`), 401);
        });

        it('refuses a booking that has no date', async () => {
            const applyOption = {
                id: '11111111-1111-4111-8111-111111111111',
                label: 'Apply',
                service_type: 'service_apply' as const,
                enabled: true,
                slots: [
                    {
                        id: '22222222-2222-4222-8222-222222222222',
                        label: 'Apply',
                        child_type: 'apply' as const,
                        value: { limit: null, booked_count: 0 },
                    },
                ],
            };
            const service = await fx.service(organization.id, { options: [applyOption] });
            const created = await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', bearer)
                .send({ option_id: applyOption.id, slot_id: applyOption.slots[0]!.id });
            expect(created.status).toBe(201);

            expectError(await ics(created.body.data.booking_id as string), 422, 'BOOKING_NOT_DATED');
        });
    });

    describe('personal subscription', () => {
        it('serves the feed by a read-only token that follows moves and cancellations', async () => {
            const moved = await book('10:00');
            const cancelled = await book('11:00');
            const issued = await t.http.post(`${t.prefix}/me/calendar-token`).set('Authorization', bearer);
            expect(issued.status).toBe(201);
            expect(issued.body.data.path).toBe(
                `${t.prefix}/me/bookings.ics?token=${issued.body.data.token as string}`,
            );

            const feed = () => t.http.get(issued.body.data.path as string);
            const first = await feed();
            expect(first.status).toBe(200);
            expect(first.headers['content-type']).toBe('text/calendar; charset=utf-8');
            expect(first.headers['cache-control']).toBe('private, no-store, max-age=0');
            expect(unfold(first.text)).toEqual(
                expect.arrayContaining([
                    'X-WR-CALNAME:Smart City bookings',
                    `UID:booking-${moved}@city.example.com`,
                ]),
            );

            expect(
                (await t.http.delete(`${t.prefix}/bookings/${cancelled}`).set('Authorization', bearer))
                    .status,
            ).toBe(204);
            expect(
                (
                    await t.http
                        .post(`${t.prefix}/bookings/${moved}/reschedule`)
                        .set('Authorization', bearer)
                        .send({ slot_id: option.slot_id, time: '11:00' })
                ).status,
            ).toBe(200);

            const events = (await feed()).text.split('BEGIN:VEVENT').slice(1).map(unfold);
            const movedEvent = events.find((lines) =>
                lines.includes(`UID:booking-${moved}@city.example.com`),
            );
            const cancelledEvent = events.find((lines) =>
                lines.includes(`UID:booking-${cancelled}@city.example.com`),
            );
            expect(movedEvent).toContain(`DTSTART:${utcStamp(instantIn(date, '11:00', ZONE))}`);
            expect(movedEvent).toContain('SEQUENCE:1');
            expect(cancelledEvent).toContain('STATUS:CANCELLED');
        });

        it('keeps the nearest bookings when the feed is over its cap, and recent past ones when it is not', async () => {
            const issued = await t.http.post(`${t.prefix}/me/calendar-token`).set('Authorization', bearer);
            const bookings = fx.collection('Booking');
            const row = (id: string, startsAt: Date) => ({
                id,
                service_id: new Types.ObjectId(serviceId),
                organization_id: new Types.ObjectId(organization.id),
                option_id: option.id,
                slot_id: option.slot_id,
                child_type: 'date_time',
                slot_date: startsAt.toISOString().slice(0, 10),
                slot_time: startsAt.toISOString().slice(11, 16),
                starts_at: startsAt,
                user_id: new Types.ObjectId(client.id),
                status: 'cancelled',
                active: false,
            });
            const day = 24 * 3_600_000;
            const uids = async (): Promise<string[]> =>
                unfold((await t.http.get(issued.body.data.path as string)).text)
                    .filter((line) => line.startsWith('UID:'))
                    .map((line) => line.slice('UID:booking-'.length).split('@')[0]!);

            await bookings.insertMany([
                row('past-recent', new Date(Date.now() - 2 * day)),
                row('past-old', new Date(Date.now() - 40 * day)),
                row('future-0', new Date(Date.now() + day)),
            ]);
            expect(await uids()).toEqual(['past-recent', 'future-0']);

            await bookings.insertMany(
                Array.from({ length: CALENDAR_FEED.maxEvents }, (_, index) =>
                    row(`future-${index + 1}`, new Date(Date.now() + (index + 2) * day)),
                ),
            );
            const capped = await uids();
            expect(capped).toHaveLength(CALENDAR_FEED.maxEvents);
            expect(capped[0]).toBe('future-0');
            expect(capped).not.toContain('past-recent');
            expect(capped).not.toContain(`future-${CALENDAR_FEED.maxEvents}`);
        });

        it('stops answering a rotated or revoked token and never an unknown one', async () => {
            const first = await t.http.post(`${t.prefix}/me/calendar-token`).set('Authorization', bearer);
            const second = await t.http.post(`${t.prefix}/me/calendar-token`).set('Authorization', bearer);

            expectError(await t.http.get(first.body.data.path as string), 401, 'TOKEN_INVALID');
            expect((await t.http.get(second.body.data.path as string)).status).toBe(200);

            expect(
                (await t.http.delete(`${t.prefix}/me/calendar-token`).set('Authorization', bearer)).status,
            ).toBe(204);
            expectError(await t.http.get(second.body.data.path as string), 401, 'TOKEN_INVALID');
            expectError(await t.http.get(`${t.prefix}/me/bookings.ics`), 401, 'TOKEN_INVALID');
            expectError(await t.http.get(`${t.prefix}/me/bookings.ics?token=unknown`), 401, 'TOKEN_INVALID');
        });

        it('stores only a hash of the token', async () => {
            const issued = await t.http.post(`${t.prefix}/me/calendar-token`).set('Authorization', bearer);
            const stored = await fx
                .collection<{ calendar_token_hash?: string }>('User')
                .findById(client.id)
                .select('+calendar_token_hash')
                .lean();

            expect(stored?.calendar_token_hash).toMatch(/^[a-f0-9]{64}$/);
            expect(stored?.calendar_token_hash).not.toContain(issued.body.data.token as string);

            const me = await t.http.get(`${t.prefix}/users/${client.id}`).set('Authorization', bearer);
            expect(JSON.stringify(me.body)).not.toContain('calendar_token');
        });
    });

    it('attaches the booking to the reminder e-mail', async () => {
        const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);

        try {
            await t.http
                .patch(`${t.prefix}/users/${client.id}`)
                .set('Authorization', bearer)
                .send({ email: 'anna@example.com' });
            const id = await book();
            const start = instantIn(date, '10:00', ZONE);
            expect(
                await t.app.get(BookingRemindersJob).execute(new Date(start.getTime() - 3_600_000)),
            ).toMatchObject({ reminders: 1 });
            await waitFor(
                async () =>
                    (await fx
                        .collection('OutboxEvent')
                        .countDocuments({ type: 'booking.reminder', status: 'delivered' })) === 1,
            );

            const message: MailMessage = mail.mock.calls[0]![0];
            expect(message.text).toContain('booking.ics');
            expect(message.attachments).toHaveLength(1);
            expect(message.attachments![0]).toMatchObject({
                filename: 'booking.ics',
                content_type: 'text/calendar; charset=utf-8',
            });
            expect(message.attachments![0]!.content.toString('utf8')).toContain(
                `UID:booking-${id}@city.example.com`,
            );
        } finally {
            mail.mockRestore();
        }
    });
});
