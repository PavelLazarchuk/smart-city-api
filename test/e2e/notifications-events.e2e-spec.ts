import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { type OutboxEventEntity } from '../../src/common/outbox/outbox.repository';
import { NotificationDispatcher } from '../../src/modules/notifications/notification-dispatcher.service';
import { type OptionTree } from '../../src/modules/services/slot.logic';
import { waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
    id: string;
    type: string;
    audience: string;
    status: string;
    title: string;
    body: string;
    organization: { id: string; label: string };
    data: Record<string, unknown>;
}

function dateIn(days: number): string {
    return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

describe('notifications: events (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string; main_label: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let operatorBearer: string;
    let client: FixtureUser;
    let clientBearer: string;
    let option: OptionTree & { slot_id: string };
    let serviceId: string;

    const policy = (overrides: Record<string, unknown> = {}) => ({
        max_active_per_user: null,
        lead_time_minutes: null,
        max_advance_days: null,
        cancel_deadline_minutes: null,
        late_cancel: 'forbid' as const,
        requires_confirmation: false,
        no_show_limit: null,
        no_show_window_days: null,
        no_show_suspension_days: null,
        ...overrides,
    });

    const twoTimes = (): OptionTree & { slot_id: string } => {
        const slotId = randomUUID();

        return {
            id: randomUUID(),
            label: 'Booking',
            service_type: 'service_apply',
            enabled: true,
            slots: [
                {
                    id: slotId,
                    label: 'Date',
                    child_type: 'date_time',
                    value: {
                        date: dateIn(1),
                        time: [
                            { time: '10:00', limit: 5, booked_count: 0 },
                            { time: '11:00', limit: 5, booked_count: 0 },
                        ],
                    },
                },
            ],
            slot_id: slotId,
        };
    };

    const inbox = (bearer: string, query = '') =>
        t.http.get(`${t.prefix}/me/notifications${query}`).set('Authorization', bearer);

    const unread = async (bearer: string, query = ''): Promise<number> =>
        (await t.http.get(`${t.prefix}/me/notifications/unread-count${query}`).set('Authorization', bearer))
            .body.data.unread as number;

    const rows = async (bearer: string, query = ''): Promise<Row[]> =>
        (await inbox(bearer, query)).body.data as Row[];

    const book = (bearer = clientBearer, body: Record<string, unknown> = {}, service = serviceId) =>
        t.http
            .post(`${t.prefix}/services/${service}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00', ...body });

    const settled = () =>
        waitFor(
            async () =>
                (await fx.collection('OutboxEvent').countDocuments({ status: { $ne: 'delivered' } })) === 0,
        );

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization({ main_label: 'City Clinic' });
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
        operatorBearer = await fx.bearer(
            await fx.user({ role: 'operator', organization_ids: [organization.id] }),
        );
        client = await fx.client({ name: 'Anna' });
        clientBearer = await fx.bearer(client);
        option = twoTimes();
        serviceId = (
            await fx.service(organization.id, {
                options: [option],
                booking_policy: policy(),
                value: { heading_value: 'Massage' },
            })
        ).id;
    });

    describe('events', () => {
        it('tells the staff of the organization once, as one shared row, when a client books', async () => {
            const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));
            const superAdmin = await fx.bearer(await fx.superAdmin());

            expect((await book()).status).toBe(201);
            await settled();

            const [row] = await rows(adminBearer);
            expect(row).toMatchObject({
                type: 'client_booked',
                audience: 'staff',
                status: 'unread',
                title: 'New booking',
                organization: { id: organization.id, label: 'City Clinic' },
                data: {
                    service_label: 'Massage',
                    time: '10:00',
                    client_name: 'Anna',
                    client_phone: client.phone,
                    requires_action: false,
                },
            });
            expect(row!.body).toBe(`Anna (${client.phone}) booked Massage on ${dateIn(1)} at 10:00.`);
            expect(await fx.collection('Notification').countDocuments()).toBe(1);
            expect((await rows(operatorBearer)).map((item) => item.id)).toEqual([row!.id]);
            expect(await unread(clientBearer)).toBe(0);
            expect(await unread(foreign)).toBe(0);
            expect(await unread(superAdmin)).toBe(0);

            const read = await t.http
                .post(`${t.prefix}/me/notifications/${row!.id}/read`)
                .set('Authorization', operatorBearer);
            expect(read.status).toBe(204);
            expect(await unread(adminBearer)).toBe(0);
            expect((await rows(adminBearer))[0]).toMatchObject({ status: 'read' });
        });

        it('tells the client what the staff did and the staff what the client did, never the actor', async () => {
            const first = await fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
                slot_date: dateIn(1),
                person: 'Anna',
                phone: client.phone,
            });
            const second = await fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '11:00',
                slot_date: dateIn(1),
                person: 'Anna',
                phone: client.phone,
            });

            expect(
                (await t.http.delete(`${t.prefix}/bookings/${second.id}`).set('Authorization', clientBearer))
                    .status,
            ).toBe(204);
            expect(
                (
                    await t.http
                        .post(`${t.prefix}/bookings/${first.id}/reschedule`)
                        .set('Authorization', adminBearer)
                        .send({ slot_id: option.slot_id, time: '11:00' })
                ).status,
            ).toBe(200);
            expect(
                (
                    await t.http
                        .post(`${t.prefix}/bookings/${first.id}/reschedule`)
                        .set('Authorization', clientBearer)
                        .send({ slot_id: option.slot_id, time: '10:00' })
                ).status,
            ).toBe(200);
            expect(
                (await t.http.delete(`${t.prefix}/bookings/${first.id}`).set('Authorization', adminBearer))
                    .status,
            ).toBe(204);
            await settled();

            const own = await rows(clientBearer);
            expect(own.map((row) => row.type)).toEqual(['booking_cancelled', 'booking_rescheduled']);
            expect(own[0]!.body).toBe(`City Clinic cancelled Service on ${dateIn(1)} at 10:00.`);
            expect(own[1]!.body).toBe(
                `City Clinic moved Service from ${dateIn(1)} 10:00 to ${dateIn(1)} at 11:00.`,
            );
            expect(own[1]!.data).toMatchObject({ previous_time: '10:00', time: '11:00' });
            expect(own.every((row) => row.data['client_phone'] === undefined)).toBe(true);

            const staff = await rows(adminBearer);
            expect(staff.map((row) => row.type)).toEqual(['client_rescheduled', 'client_cancelled']);
            expect(staff[1]!.title).toBe('Booking cancelled by the client');
        });

        it('asks the staff to confirm, then tells the client it was confirmed or declined', async () => {
            await fx
                .collection('Service')
                .updateOne(
                    { _id: new Types.ObjectId(serviceId) },
                    { $set: { booking_policy: policy({ requires_confirmation: true }) } },
                );
            const other = await fx.client();
            const otherBearer = await fx.bearer(other);

            const accepted = await book();
            const declined = await book(otherBearer);
            await settled();

            const requests = await rows(adminBearer);
            expect(requests.map((row) => [row.title, row.data['requires_action']])).toEqual([
                ['Booking request', true],
                ['Booking request', true],
            ]);
            expect(requests[0]!.body).toContain('The booking waits for confirmation.');

            expect(
                (
                    await t.http
                        .post(`${t.prefix}/bookings/${accepted.body.data.booking_id as string}/confirm`)
                        .set('Authorization', operatorBearer)
                ).status,
            ).toBe(200);
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/bookings/${declined.body.data.booking_id as string}`)
                        .set('Authorization', operatorBearer)
                ).status,
            ).toBe(204);
            await settled();

            expect((await rows(clientBearer)).map((row) => row.type)).toEqual(['booking_confirmed']);
            expect((await rows(otherBearer)).map((row) => row.type)).toEqual(['booking_rejected']);
        });

        it('tells the client about a booking made for them and keeps it out of the staff feed', async () => {
            const res = await book(adminBearer, { on_behalf: { phone: '4915290007777', name: 'Walk-in' } });
            expect(res.status).toBe(201);
            await settled();

            const walkIn = await fx
                .collection<{ _id: Types.ObjectId }>('User')
                .findOne({ phone: '4915290007777' })
                .lean();
            const walkInBearer = await fx.bearer({
                id: walkIn!._id.toHexString(),
                role: 'common-user',
                organization_ids: [],
            });

            expect((await rows(walkInBearer)).map((row) => [row.type, row.body])).toEqual([
                ['booking_created_for_you', `City Clinic booked Massage on ${dateIn(1)} at 10:00 for you.`],
            ]);
            expect(await unread(adminBearer)).toBe(0);
        });

        it('tells every client of a closed or moved slot, even when the staff chose not to send SMS', async () => {
            await book();
            await settled();

            const base = `${t.prefix}/services/${serviceId}/options/${option.id}/slots/${option.slot_id}`;
            const moved = await t.http
                .post(`${base}/move`)
                .set('Authorization', adminBearer)
                .send({ date: dateIn(2), reason: 'Renovation', notify: true });
            expect(moved.status).toBe(200);
            const closed = await t.http
                .post(`${base}/cancel`)
                .set('Authorization', adminBearer)
                .send({ reason: 'The specialist is ill.', notify: false });
            expect(closed.status).toBe(200);
            expect(closed.body.data.notifications_queued).toBe(0);
            await settled();

            const own = await rows(clientBearer);
            expect(own.map((row) => row.type)).toEqual(['slot_cancelled', 'slot_moved']);
            expect(own[0]!.body).toBe(
                `Massage on ${dateIn(2)} at 10:00 was cancelled: City Clinic closed the slot. Reason: The specialist is ill.`,
            );
            expect(own[1]!.data).toMatchObject({
                date: dateIn(2),
                previous_date: dateIn(1),
                reason: 'Renovation',
            });
            expect(await fx.collection('Notification').countDocuments({ audience: 'staff' })).toBe(1);
        });

        it('tells the client and the staff about a no-show suspension and the client when it is lifted', async () => {
            await fx.collection('Service').updateOne(
                { _id: new Types.ObjectId(serviceId) },
                {
                    $set: {
                        booking_policy: policy({
                            no_show_limit: 1,
                            no_show_window_days: 30,
                            no_show_suspension_days: 7,
                        }),
                    },
                },
            );
            const { id } = await fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
                slot_date: dateIn(1),
                person: 'Anna',
                phone: client.phone,
            });
            const mark = (status: string) =>
                t.http
                    .patch(`${t.prefix}/bookings/${id}/status`)
                    .set('Authorization', operatorBearer)
                    .send({ status });

            expect((await mark('no_show')).status).toBe(200);
            await settled();

            const [suspended] = await rows(clientBearer);
            expect(suspended).toMatchObject({ type: 'booking_suspended', data: { missed: 1 } });
            expect(suspended!.body).toMatch(
                /^You missed 1 bookings of Massage\. City Clinic suspended booking Massage until \d{4}-\d{2}-\d{2}\.$/,
            );
            const [staff] = await rows(adminBearer);
            expect(staff).toMatchObject({
                type: 'client_suspended',
                data: { client_name: 'Anna', client_phone: client.phone, missed: 1 },
            });

            expect((await mark('completed')).status).toBe(200);
            await settled();

            expect((await rows(clientBearer)).map((row) => row.type)).toEqual([
                'booking_suspension_lifted',
                'booking_suspended',
            ]);
            expect(await unread(adminBearer)).toBe(1);
        });

        it('writes one row per event even when the event is delivered again', async () => {
            await book();
            await settled();
            const event = await fx
                .collection<OutboxEventEntity>('OutboxEvent')
                .findOne({ type: 'booking.created' })
                .lean<OutboxEventEntity>();

            await t.app.get(NotificationDispatcher).deliver(event!);
            await t.app.get(NotificationDispatcher).deliver(event!);

            expect(await fx.collection('Notification').countDocuments()).toBe(1);
        });
    });
});
