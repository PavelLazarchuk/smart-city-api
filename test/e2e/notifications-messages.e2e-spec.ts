import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { NOTIFICATIONS } from '../../src/common/config/constants';
import { type OptionTree } from '../../src/modules/services/slot.logic';
import { collectKeys, expectError } from '../support/assertions';
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

describe('notifications: messages and privacy (e2e)', () => {
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
