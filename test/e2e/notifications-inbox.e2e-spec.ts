import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { NOTIFICATIONS } from '../../src/common/config/constants';
import { type OptionTree } from '../../src/modules/services/slot.logic';
import { expectError } from '../support/assertions';
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

describe('notifications: scope and reading (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string; main_label: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let operatorBearer: string;
    let client: FixtureUser;
    let clientBearer: string;
    let option: OptionTree & { slot_id: string };
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
        await fx.service(organization.id, {
            options: [option],
            booking_policy: policy(),
            value: { heading_value: 'Massage' },
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
});
