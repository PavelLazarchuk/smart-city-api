import { expectError } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const uuid = (n: number) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

describe('booking statuses and policy (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let client: FixtureUser;
    let bearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
        client = await fx.client({ name: 'Anna', phone: '4915291234567' });
        bearer = await fx.bearer(client);
    });

    const book = (serviceId: string, body: Record<string, unknown>, token = bearer) =>
        t.http.post(`${t.prefix}/services/${serviceId}/bookings`).set('Authorization', token).send(body);

    const serviceWith = (
        overrides: Record<string, unknown>,
        days = 2,
        time = '10:00',
        limit: number | null = 2,
    ) =>
        fx.service(organization.id, {
            options: [
                {
                    id: uuid(1),
                    label: 'x',
                    service_type: 'service_apply',
                    enabled: true,
                    slots: [
                        {
                            id: uuid(2),
                            label: 'd',
                            child_type: 'date_time',
                            value: {
                                date: dateOnly(days),
                                time: [
                                    { time, limit, booked_count: 0 },
                                    { time: '11:00', limit, booked_count: 0 },
                                ],
                            },
                        },
                        {
                            id: uuid(3),
                            label: 'a',
                            child_type: 'apply',
                            value: { limit: null, booked_count: 0 },
                        },
                    ],
                },
            ],
            ...overrides,
        });

    describe('statuses and statistics', () => {
        it('confirms, completes and marks no-shows; stats count the outcomes', async () => {
            const service = await serviceWith({ booking_policy: { requires_confirmation: true } });
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            expect(created.status).toBe(201);
            expect(created.body.data.status).toBe('pending');
            const id = created.body.data.booking_id as string;
            const status = (value: string, token = adminBearer) =>
                t.http
                    .patch(`${t.prefix}/bookings/${id}/status`)
                    .set('Authorization', token)
                    .send({ status: value });

            expectError(await status('confirmed', bearer), 403);
            expectError(await status('completed'), 422, 'BOOKING_STATUS_TRANSITION');
            const confirmed = await status('confirmed');
            expect(confirmed.status).toBe(200);
            expect(confirmed.body.data.status).toBe('confirmed');
            expect(typeof confirmed.body.data.confirmed_at).toBe('string');

            const one = await t.http.get(`${t.prefix}/bookings/${id}`).set('Authorization', bearer);
            expect(one.body.data).toMatchObject({ id, status: 'confirmed', person: 'Anna' });
            expectError(
                await t.http
                    .get(`${t.prefix}/bookings/${id}`)
                    .set('Authorization', await fx.bearer(await fx.client())),
                404,
            );

            expect((await status('no_show')).body.data).toMatchObject({ status: 'no_show' });
            expect((await status('completed')).body.data).toMatchObject({ status: 'completed' });
            expectError(await status('cancelled'), 422, 'BOOKING_STATUS_TRANSITION');

            expect(
                (await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' })).status,
            ).toBe(201);
            const other = await fx.bearer(await fx.client());
            const cancelled = await book(service.id, { option_id: uuid(1), slot_id: uuid(3) }, other);
            await t.http
                .delete(`${t.prefix}/bookings/${cancelled.body.data.booking_id}`)
                .set('Authorization', other);

            const stats = await t.http
                .get(`${t.prefix}/bookings/stats?service_id=${service.id}`)
                .set('Authorization', adminBearer);
            expect(stats.status).toBe(200);
            expect(stats.body.data).toEqual({
                total: 3,
                by_status: { pending: 1, confirmed: 0, arrived: 0, completed: 1, no_show: 0, cancelled: 1 },
                no_show_rate: 0,
                cancellation_rate: 0.5,
            });
            const active = await t.http
                .get(`${t.prefix}/bookings?status=active`)
                .set('Authorization', adminBearer);
            expect(active.body.data).toHaveLength(1);
            const all = await t.http.get(`${t.prefix}/bookings?status=all`).set('Authorization', adminBearer);
            expect(all.body.data).toHaveLength(3);
        });

        it('deleting the account cancels the active booking and keeps every row without the person', async () => {
            const service = await serviceWith({});
            const created = await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' });
            await t.http
                .patch(`${t.prefix}/bookings/${created.body.data.booking_id}/status`)
                .set('Authorization', adminBearer)
                .send({ status: 'completed' });
            await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '11:00' });

            const superBearer = await fx.bearer(await fx.superAdmin());
            expect(
                (await t.http.delete(`${t.prefix}/users/${client.id}`).set('Authorization', superBearer))
                    .status,
            ).toBe(204);
            const rows = await fx
                .collection<{ status: string; person: string; phone: string }>('Booking')
                .find({})
                .sort({ slot_time: 1 })
                .lean();
            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({ status: 'completed', person: '', phone: '' });
            expect(rows[1]).toMatchObject({ status: 'cancelled', person: '', phone: '' });
        });
    });

    describe('booking policy', () => {
        it('enforces lead time, advance window, the active limit and the cancellation deadline', async () => {
            const service = await serviceWith(
                {
                    booking_policy: {
                        lead_time_minutes: 3 * 24 * 60,
                        max_advance_days: 10,
                        max_active_per_user: 1,
                        cancel_deadline_minutes: 60,
                        late_cancel: 'forbid',
                    },
                },
                2,
            );
            expectError(
                await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' }),
                422,
                'BOOKING_LEAD_TIME',
            );

            const far = await serviceWith({ booking_policy: { max_advance_days: 10 } }, 20);
            expectError(
                await book(far.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' }),
                422,
                'BOOKING_TOO_FAR_AHEAD',
            );

            const limited = await serviceWith({ booking_policy: { max_active_per_user: 1 } });
            expect(
                (await book(limited.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' })).status,
            ).toBe(201);
            expectError(
                await book(limited.id, { option_id: uuid(1), slot_id: uuid(3) }),
                422,
                'BOOKING_LIMIT_REACHED',
            );
            expect(
                (await book(service.id, { option_id: uuid(1), slot_id: uuid(2), time: '10:00' }, adminBearer))
                    .status,
            ).toBe(201);

            const soon = await fx.service(organization.id, {
                booking_policy: {
                    max_active_per_user: null,
                    lead_time_minutes: null,
                    max_advance_days: null,
                    cancel_deadline_minutes: 48 * 60,
                    late_cancel: 'forbid',
                    requires_confirmation: false,
                    no_show_limit: null,
                    no_show_window_days: null,
                    no_show_suspension_days: null,
                },
                options: [
                    {
                        id: uuid(1),
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        slots: [
                            {
                                id: uuid(2),
                                label: 'd',
                                child_type: 'date',
                                value: { date: dateOnly(1), limit: null, booked_count: 0 },
                            },
                        ],
                    },
                ],
            });
            const created = await book(soon.id, { option_id: uuid(1), slot_id: uuid(2) });
            expect(created.status).toBe(201);
            expectError(
                await t.http
                    .delete(`${t.prefix}/bookings/${created.body.data.booking_id}`)
                    .set('Authorization', bearer),
                422,
                'BOOKING_CANCEL_DEADLINE_PASSED',
            );
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/bookings/${created.body.data.booking_id}`)
                        .set('Authorization', adminBearer)
                ).status,
            ).toBe(204);
        });

        it('validates the form answers and the confirmed documents', async () => {
            const service = await serviceWith({
                form_fields: [
                    {
                        key: 'reason',
                        label: 'Reason',
                        type: 'select',
                        required: true,
                        options: ['lost', 'expired'],
                    },
                    { key: 'age', label: 'Age', type: 'number' },
                ],
                required_documents: [{ key: 'passport', label: 'Passport', required: true }],
            });
            const target = { option_id: uuid(1), slot_id: uuid(3) };

            const invalid = await book(service.id, {
                ...target,
                fields: { reason: 'other', age: 'x', extra: 1 },
            });
            expectError(invalid, 422, 'BOOKING_FIELDS_INVALID');
            expect(invalid.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
                'fields.age',
                'fields.extra',
                'fields.reason',
            ]);
            const missing = await book(service.id, { ...target, fields: { reason: 'lost' } });
            expectError(missing, 422, 'BOOKING_DOCUMENTS_REQUIRED');
            expect(missing.body.error.details[0].path).toBe('documents.passport');

            const ok = await book(service.id, {
                ...target,
                fields: { reason: 'lost', age: 30 },
                documents: ['passport'],
            });
            expect(ok.status).toBe(201);
            const row = await t.http
                .get(`${t.prefix}/bookings/${ok.body.data.booking_id}`)
                .set('Authorization', adminBearer);
            expect(row.body.data).toMatchObject({
                fields: { reason: 'lost', age: 30 },
                documents: ['passport'],
            });
        });

        it('refuses a draft service and a temporarily closed organization to clients', async () => {
            const draft = await serviceWith({ status: 'draft', enabled: false });
            expectError(
                await book(draft.id, { option_id: uuid(1), slot_id: uuid(3) }),
                422,
                'SERVICE_NOT_PUBLISHED',
            );
            expect((await book(draft.id, { option_id: uuid(1), slot_id: uuid(3) }, adminBearer)).status).toBe(
                201,
            );

            const service = await serviceWith({});
            await t.http
                .patch(`${t.prefix}/organizations/${organization.id}`)
                .set('Authorization', adminBearer)
                .send({ status: 'temporarily_closed', closed_reason: 'Renovation' });
            expectError(
                await book(service.id, { option_id: uuid(1), slot_id: uuid(3) }),
                422,
                'ORGANIZATION_CLOSED',
            );
        });
    });
});
