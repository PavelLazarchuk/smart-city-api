import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { NOTIFICATIONS } from '../../src/common/config/constants';
import { type OutboxEventEntity } from '../../src/common/outbox/outbox.repository';
import { NotificationDispatcher } from '../../src/modules/notifications/notification-dispatcher.service';
import { type OptionTree } from '../../src/modules/services/slot.logic';
import { collectKeys, expectError, waitFor } from '../support/assertions';
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

describe('notifications (e2e)', () => {
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

    const seed = ({
        organization_id: organizationId = organization.id,
        ...overrides
    }: Partial<{
        user_id: Types.ObjectId | null;
        organization_id: string;
        audience: 'client' | 'staff';
        status: 'read' | 'unread';
        created_at: Date;
        subject_user_id: Types.ObjectId | null;
        type: string;
    }> = {}): Record<string, unknown> => ({
        id: randomUUID(),
        audience: 'client',
        user_id: new Types.ObjectId(client.id),
        organization_id: new Types.ObjectId(organizationId),
        organization_label: 'Stored label',
        type: 'booking_reminder',
        status: 'unread',
        read_at: null,
        title: 'Title',
        body: 'Body',
        data: {},
        subject_user_id: null,
        sender_id: null,
        message_id: null,
        source_event_id: null,
        created_at: new Date(),
        ...overrides,
    });

    const insert = async (...docs: Record<string, unknown>[]): Promise<void> => {
        await fx.collection('Notification').collection.insertMany(docs);
    };

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

    describe('scope', () => {
        it('gives a client one feed across organizations and lets them filter and count by organization', async () => {
            const second = await fx.organization({ main_label: 'Dental Care' });
            const own = (await fx.client()).id;
            await insert(
                seed({ organization_id: organization.id }),
                seed({ organization_id: second.id }),
                seed({ organization_id: second.id, status: 'read' }),
                seed({ organization_id: second.id, user_id: new Types.ObjectId(own) }),
            );

            const all = await rows(clientBearer);
            expect(all).toHaveLength(3);
            expect(new Set(all.map((row) => row.organization.label))).toEqual(
                new Set(['City Clinic', 'Dental Care']),
            );
            expect((await rows(clientBearer, `?organization_id=${second.id}`)).length).toBe(2);
            expect(await unread(clientBearer, `?organization_id=${second.id}`)).toBe(1);

            const counted = await t.http
                .get(`${t.prefix}/me/notifications/unread-count?by_organization=true`)
                .set('Authorization', clientBearer);
            expect(counted.body.data.unread).toBe(2);
            expect(counted.body.data.by_organization).toEqual(
                expect.arrayContaining([
                    { organization_id: organization.id, unread: 1 },
                    { organization_id: second.id, unread: 1 },
                ]),
            );
        });

        it('keeps staff inside their organizations, labels each row and follows a rename', async () => {
            const second = await fx.organization({ main_label: 'Dental Care' });
            const both = await fx.bearer(await fx.admin([organization.id, second.id]));
            const subject = new Types.ObjectId(client.id);
            await insert(
                seed({ audience: 'staff', user_id: null, subject_user_id: subject, type: 'client_booked' }),
                seed({
                    audience: 'staff',
                    user_id: null,
                    subject_user_id: subject,
                    type: 'client_booked',
                    organization_id: second.id,
                }),
            );
            const theirs = (await fx.collection<{ id: string }>('Notification').findOne({
                organization_id: new Types.ObjectId(second.id),
            }))!;

            expect(await unread(adminBearer)).toBe(1);
            expect((await rows(adminBearer)).map((row) => row.organization.id)).toEqual([organization.id]);
            expectError(
                await t.http
                    .post(`${t.prefix}/me/notifications/${theirs.id}/read`)
                    .set('Authorization', adminBearer),
                404,
                'NOTIFICATION_NOT_FOUND',
            );
            expect(
                (
                    await t.http
                        .post(`${t.prefix}/me/notifications/read-all`)
                        .set('Authorization', adminBearer)
                        .send({})
                ).body.data,
            ).toEqual({ updated: 1 });
            expect(await unread(both)).toBe(1);

            await fx
                .collection('Organization')
                .updateOne({ _id: new Types.ObjectId(second.id) }, { $set: { main_label: 'Smile Clinic' } });
            expect((await rows(both, `?organization_id=${second.id}`))[0]!.organization).toEqual({
                id: second.id,
                label: 'Smile Clinic',
            });
            expect(await unread(both, '?audience=client')).toBe(0);
            expect(await unread(clientBearer, '?audience=staff')).toBe(0);
        });

        it('hides the organization from a staff member removed from it', async () => {
            const operator = await fx.user({ role: 'operator', organization_ids: [organization.id] });
            const bearer = await fx.bearer(operator);
            await insert(
                seed({
                    audience: 'staff',
                    user_id: null,
                    subject_user_id: new Types.ObjectId(client.id),
                    type: 'client_booked',
                }),
            );
            const [row] = await rows(bearer);

            await fx
                .collection('User')
                .updateOne({ _id: new Types.ObjectId(operator.id) }, { $set: { organization_ids: [] } });

            expect(await unread(bearer)).toBe(0);
            expect(await rows(bearer)).toEqual([]);
            expectError(
                await t.http
                    .post(`${t.prefix}/me/notifications/${row!.id}/read`)
                    .set('Authorization', bearer),
                404,
                'NOTIFICATION_NOT_FOUND',
            );
        });

        it('does not show a staff member the staff rows about their own bookings', async () => {
            const subject = new Types.ObjectId(admin.id);
            await insert(seed({ audience: 'staff', user_id: null, subject_user_id: subject }));

            expect(await unread(adminBearer)).toBe(0);
            expect(await unread(operatorBearer)).toBe(1);
        });
    });

    describe('reading', () => {
        it('lists unread first, then read, and pages across the boundary', async () => {
            const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
            await insert(
                seed({ status: 'read', created_at: at(1) }),
                seed({ status: 'unread', created_at: at(2) }),
                seed({ status: 'read', created_at: at(3) }),
                seed({ status: 'unread', created_at: at(4) }),
                seed({ status: 'unread', created_at: at(5) }),
            );

            const first = await inbox(clientBearer, '?limit=2');
            expect(first.body.data.map((row: Row) => row.status)).toEqual(['unread', 'unread']);
            expect(first.body.meta).toMatchObject({ total: 5, unread: 3, has_next: true });

            const boundary = await inbox(clientBearer, '?limit=2&page=2');
            expect(boundary.body.data.map((row: Row) => row.status)).toEqual(['unread', 'read']);

            const last = await inbox(clientBearer, '?limit=2&page=3');
            expect(last.body.data.map((row: Row) => row.status)).toEqual(['read']);

            const whole = await rows(clientBearer);
            expect(whole.map((row) => row.status)).toEqual(['unread', 'unread', 'unread', 'read', 'read']);
            expect([...whole.slice(0, 3)].map((row) => row.id)).toEqual(
                [...first.body.data, boundary.body.data[0]].map((row: Row) => row.id),
            );

            expect((await inbox(clientBearer, '?status=read')).body.meta).toMatchObject({
                total: 2,
                unread: 3,
            });
            expect((await rows(clientBearer, '?status=unread')).length).toBe(3);
        });

        it('marks one notification idempotently and reads all up to a moment', async () => {
            const earlier = new Date(Date.now() - 60_000);
            await insert(
                seed({ created_at: earlier }),
                seed({ created_at: new Date(Date.now() - 120_000) }),
                seed({ created_at: new Date() }),
            );
            const [, middle] = await rows(clientBearer);
            const read = () =>
                t.http
                    .post(`${t.prefix}/me/notifications/${middle!.id}/read`)
                    .set('Authorization', clientBearer);

            expect((await read()).status).toBe(204);
            expect((await read()).status).toBe(204);
            expect(await unread(clientBearer)).toBe(2);

            const other = await fx.bearer(await fx.client());
            expectError(
                await t.http
                    .post(`${t.prefix}/me/notifications/${middle!.id}/read`)
                    .set('Authorization', other),
                404,
                'NOTIFICATION_NOT_FOUND',
            );

            const all = await t.http
                .post(`${t.prefix}/me/notifications/read-all`)
                .set('Authorization', clientBearer)
                .send({ before: earlier.toISOString() });
            expect(all.status).toBe(200);
            expect(all.body.data).toEqual({ updated: 1 });
            expect(await unread(clientBearer)).toBe(1);
            expect((await rows(clientBearer))[0]!.status).toBe('unread');
        });

        it('keeps only the newest read notifications', async () => {
            const keep = NOTIFICATIONS.keepRead;
            await insert(
                ...Array.from({ length: keep + 5 }, (_, i) =>
                    seed({ created_at: new Date(Date.now() - (i + 1) * 60_000) }),
                ),
            );
            const newest = (await rows(clientBearer, `?limit=${keep}`)).map((row) => row.id);

            await t.http
                .post(`${t.prefix}/me/notifications/read-all`)
                .set('Authorization', clientBearer)
                .send({});

            const left = await rows(clientBearer, '?limit=100');
            expect(left).toHaveLength(keep);
            expect(left.map((row) => row.id)).toEqual(newest);
        });

        it('keeps the staff read rows per organization', async () => {
            const keep = NOTIFICATIONS.keepRead;
            await insert(
                ...Array.from({ length: keep + 2 }, (_, i) =>
                    seed({
                        audience: 'staff',
                        user_id: null,
                        subject_user_id: new Types.ObjectId(client.id),
                        created_at: new Date(Date.now() - (i + 1) * 60_000),
                    }),
                ),
            );

            await t.http
                .post(`${t.prefix}/me/notifications/read-all`)
                .set('Authorization', operatorBearer)
                .send({});

            expect(await fx.collection('Notification').countDocuments({ audience: 'staff' })).toBe(keep);
            expect((await inbox(adminBearer, '?limit=100')).body.meta).toMatchObject({
                total: keep,
                unread: 0,
            });
        });

        it('validates the queries', async () => {
            expectError(await inbox(clientBearer, '?status=nope'), 400, 'VALIDATION_ERROR');
            expectError(await inbox(clientBearer, '?organization_id=x'), 400, 'VALIDATION_ERROR');
            expectError(
                await t.http
                    .post(`${t.prefix}/me/notifications/read-all`)
                    .set('Authorization', clientBearer)
                    .send({ before: 'yesterday' }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(await inbox(''), 401);
        });
    });

    describe('messages', () => {
        const send = (
            body: Record<string, unknown>,
            bearer = adminBearer,
            organizationId = organization.id,
        ) =>
            t.http
                .post(`${t.prefix}/organizations/${organizationId}/messages`)
                .set('Authorization', bearer)
                .send(body);

        const asClient = async (user = client) =>
            fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: user.id,
                status: 'completed',
                person: user.name,
                phone: user.phone,
            });

        it('delivers a plain-text message to a client of the organization', async () => {
            await asClient();

            const sent = await send({ user_id: client.id, body: '  <b>Room 214</b>\r\nSee you.  ' });

            expect(sent.status).toBe(201);
            expect(sent.body.data).toMatchObject({
                user_id: client.id,
                title: 'Message from City Clinic',
                body: '<b>Room 214</b>\nSee you.',
            });
            expect(Object.keys(sent.body.data).sort()).toEqual([
                'body',
                'created_at',
                'message_id',
                'title',
                'user_id',
            ]);
            const [row] = await rows(clientBearer);
            expect(row).toMatchObject({
                type: 'organization_message',
                audience: 'client',
                title: 'Message from City Clinic',
                body: '<b>Room 214</b>\nSee you.',
                organization: { id: organization.id, label: 'City Clinic' },
                data: {},
            });
            const stored = await fx
                .collection<{ sender_id: Types.ObjectId; message_id: string }>('Notification')
                .findOne({ type: 'organization_message' })
                .lean();
            expect(stored?.sender_id.toHexString()).toBe(admin.id);
            expect(stored?.message_id).toBe(sent.body.data.message_id);

            const titled = await send(
                { user_id: client.id, title: 'Room\nchange', body: 'x' },
                operatorBearer,
            );
            expect(titled.status).toBe(201);
            expect(titled.body.data.title).toBe('Room change');
        });

        it('answers the same 404 for a stranger and a missing account, and keeps other organizations out', async () => {
            await asClient();
            const stranger = await fx.client();
            const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));

            expectError(await send({ user_id: stranger.id, body: 'x' }), 404, 'CLIENT_NOT_FOUND');
            expectError(
                await send({ user_id: new Types.ObjectId().toHexString(), body: 'x' }),
                404,
                'CLIENT_NOT_FOUND',
            );
            expectError(
                await send({ user_id: client.id, body: 'x' }, foreign),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
            expectError(await send({ user_id: client.id, body: 'x' }, clientBearer), 403, 'FORBIDDEN');
            expectError(await send({ user_id: client.id, body: '   ' }), 400, 'VALIDATION_ERROR');
            expectError(await send({ user_id: client.id, body: 'x'.repeat(1001) }), 400, 'VALIDATION_ERROR');
            expectError(
                await send(
                    { user_id: client.id, body: 'x' },
                    await fx.bearer(await fx.superAdmin()),
                    new Types.ObjectId().toHexString(),
                ),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
            expect(await unread(clientBearer)).toBe(0);
        });

        it('replays a message sent with the same Idempotency-Key', async () => {
            await asClient();
            const post = (body: Record<string, unknown>) =>
                t.http
                    .post(`${t.prefix}/organizations/${organization.id}/messages`)
                    .set('Authorization', adminBearer)
                    .set('Idempotency-Key', 'message-1')
                    .send(body);

            const first = await post({ user_id: client.id, body: 'Hello' });
            const again = await post({ user_id: client.id, body: 'Hello' });

            expect(first.status).toBe(201);
            expect(again.status).toBe(201);
            expect(again.headers['idempotency-replayed']).toBe('true');
            expect(again.body.data.message_id).toBe(first.body.data.message_id);
            expect(await unread(clientBearer)).toBe(1);
            expectError(await post({ user_id: client.id, body: 'Other' }), 422, 'IDEMPOTENCY_KEY_REUSED');
        });

        it('drops the oldest unread rows above the cap', async () => {
            await asClient();
            await insert(
                ...Array.from({ length: NOTIFICATIONS.maxUnread }, (_, i) =>
                    seed({ created_at: new Date(Date.now() - (i + 1) * 60_000) }),
                ),
            );
            const oldest = await fx
                .collection<{ id: string }>('Notification')
                .findOne({}, { id: 1 }, { sort: { created_at: 1 } })
                .lean();

            expect((await send({ user_id: client.id, body: 'Hello' })).status).toBe(201);

            expect(await unread(clientBearer)).toBe(NOTIFICATIONS.maxUnread);
            expect(await fx.collection('Notification').countDocuments({ id: oldest!.id })).toBe(0);
            expect((await rows(clientBearer))[0]!.type).toBe('organization_message');
        });

        it('lists the clients of the organization to pick a recipient from', async () => {
            await asClient();
            await asClient();
            const other = await fx.client({ name: 'Boris' });
            await asClient(other);
            const gone = await fx.client({ name: 'Gone' });
            await asClient(gone);
            await fx.collection('User').deleteOne({ _id: new Types.ObjectId(gone.id) });
            const elsewhere = await fx.organization();
            await fx.booking({
                service_id: (await fx.service(elsewhere.id, { options: [twoTimes()] })).id,
                organization_id: elsewhere.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: (await fx.client({ name: 'Stranger' })).id,
                status: 'completed',
            });

            const listed = await t.http
                .get(`${t.prefix}/organizations/${organization.id}/clients`)
                .set('Authorization', operatorBearer);
            expect(listed.status).toBe(200);
            expect(listed.body.meta.total).toBe(2);
            expect(listed.body.data.map((row: { name: string }) => row.name).sort()).toEqual([
                'Anna',
                'Boris',
            ]);
            expect(listed.body.data.find((row: { name: string }) => row.name === 'Anna')).toMatchObject({
                user_id: client.id,
                phone: client.phone,
                bookings: 2,
            });

            const searched = await t.http
                .get(`${t.prefix}/organizations/${organization.id}/clients?q=bor`)
                .set('Authorization', adminBearer);
            expect(searched.body.data.map((row: { user_id: string }) => row.user_id)).toEqual([other.id]);

            const foreign = await fx.bearer(await fx.admin([elsewhere.id]));
            expectError(
                await t.http
                    .get(`${t.prefix}/organizations/${organization.id}/clients`)
                    .set('Authorization', foreign),
                404,
                'ORGANIZATION_NOT_FOUND',
            );
            expectError(
                await t.http
                    .get(`${t.prefix}/organizations/${organization.id}/clients`)
                    .set('Authorization', clientBearer),
                403,
                'FORBIDDEN',
            );
        });
    });

    describe('privacy and cascades', () => {
        it('never exposes the internal ids', async () => {
            await insert(
                {
                    ...seed(),
                    sender_id: new Types.ObjectId(admin.id),
                    message_id: 'm',
                    type: 'organization_message',
                },
                {
                    ...seed({
                        audience: 'staff',
                        user_id: null,
                        subject_user_id: new Types.ObjectId(client.id),
                    }),
                    source_event_id: 'e',
                },
            );

            for (const bearer of [clientBearer, adminBearer]) {
                const keys = collectKeys((await inbox(bearer)).body);

                for (const key of [
                    'sender_id',
                    'subject_user_id',
                    'source_event_id',
                    'user_id',
                    'message_id',
                    '_id',
                ])
                    expect(keys.has(key)).toBe(false);
            }
        });

        it('removes the inbox and the staff rows about a deleted client, and everything of a deleted organization', async () => {
            const superAdmin = await fx.bearer(await fx.superAdmin());
            const subject = new Types.ObjectId(client.id);
            const second = await fx.organization();
            await insert(
                seed(),
                seed({ audience: 'staff', user_id: null, subject_user_id: subject }),
                seed({ organization_id: second.id, user_id: new Types.ObjectId(admin.id) }),
                seed({ organization_id: second.id, audience: 'staff', user_id: null, subject_user_id: null }),
            );

            expect(
                (await t.http.delete(`${t.prefix}/users/${client.id}`).set('Authorization', superAdmin))
                    .status,
            ).toBe(204);
            expect(await fx.collection('Notification').countDocuments()).toBe(2);

            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/organizations/${second.id}`)
                        .set('Authorization', superAdmin)
                ).status,
            ).toBe(204);
            expect(await fx.collection('Notification').countDocuments()).toBe(0);
        });
    });
});
