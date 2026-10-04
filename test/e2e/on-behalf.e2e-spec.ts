import { Types } from 'mongoose';

import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('booking on behalf of a walk-in client (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let option: ReturnType<Fixtures['bookableOption']>;
    let serviceId: string;

    const book = (body: Record<string, unknown>, token = adminBearer) =>
        t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', token)
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00', ...body });

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
        option = fx.bookableOption(1);
        serviceId = (
            await fx.service(organization.id, {
                options: [option],
                booking_policy: {
                    requires_confirmation: true,
                    lead_time_minutes: 7 * 24 * 60,
                    max_active_per_user: 1,
                    max_advance_days: null,
                    cancel_deadline_minutes: null,
                    late_cancel: 'forbid',
                    no_show_limit: null,
                    no_show_window_days: null,
                    no_show_suspension_days: null,
                },
            })
        ).id;
    });

    it('creates the client by phone and books a confirmed place in their name', async () => {
        const res = await book({ on_behalf: { phone: '4915290001111', name: 'Walk-in' } });

        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('confirmed');
        expect(res.headers['location']).toBe(`/bookings/${res.body.data.booking_id as string}`);

        const account = await fx
            .collection<{ _id: Types.ObjectId; role: string; name: string }>('User')
            .findOne({ phone: '4915290001111' })
            .lean();
        expect(account).toMatchObject({ role: 'common-user', name: 'Walk-in' });
        expect(res.body.data.user_id).toBe(account?._id.toHexString());

        const booking = await t.http
            .get(`${t.prefix}/bookings/${res.body.data.booking_id as string}`)
            .set('Authorization', adminBearer);
        expect(booking.body.data).toMatchObject({
            user_id: res.body.data.user_id,
            person: 'Walk-in',
            phone: '4915290001111',
            created_by: admin.id,
            status: 'confirmed',
        });

        const client = await fx.bearer({
            id: res.body.data.user_id as string,
            role: 'common-user',
            organization_ids: [],
        });
        const own = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', client);
        expect(own.body.data.map((row: { id: string }) => row.id)).toEqual([res.body.data.booking_id]);
    });

    it('reuses the account that already owns the phone without renaming it', async () => {
        const existing = await fx.client({ phone: '4915290002222', name: 'Registered' });
        const res = await book({ on_behalf: { phone: '4915290002222', name: 'At the desk' } });

        expect(res.status).toBe(201);
        expect(res.body.data.user_id).toBe(existing.id);
        expect(await fx.collection('User').countDocuments({ phone: '4915290002222' })).toBe(1);

        const account = await fx.collection<{ name: string }>('User').findById(existing.id).lean();
        expect(account?.name).toBe('Registered');

        const booking = await t.http
            .get(`${t.prefix}/bookings/${res.body.data.booking_id as string}`)
            .set('Authorization', adminBearer);
        expect(booking.body.data.person).toBe('At the desk');
    });

    it('skips the client rules of the booking policy but still respects capacity', async () => {
        const client = await fx.client();
        expectError(await book({}, await fx.bearer(client)), 422, 'BOOKING_LEAD_TIME');

        expect((await book({ on_behalf: { phone: '4915290003333', name: 'First' } })).status).toBe(201);
        expectError(await book({ on_behalf: { phone: '4915290004444', name: 'Second' } }), 422, 'SLOT_FULL');
    });

    it('is reserved for the admins of the organization', async () => {
        const body = { on_behalf: { phone: '4915290005555', name: 'Nobody' } };
        const client = await fx.bearer(await fx.client());
        const stranger = await fx.bearer(await fx.admin([(await fx.organization()).id]));

        expectError(await book(body, client), 403, 'FORBIDDEN');
        expectError(await book(body, stranger), 403, 'FORBIDDEN');
        expect(await fx.collection('User').countDocuments({ phone: '4915290005555' })).toBe(0);
        expect((await book(body, await fx.bearer(await fx.superAdmin()))).status).toBe(201);
    });

    it('never books into a staff account that owns the phone', async () => {
        const staff = await fx.user({ role: 'common-admin', phone: '4915290008888', organization_ids: [] });

        expectError(
            await book({ on_behalf: { phone: '4915290008888', name: 'Pretender' } }),
            422,
            'CLIENT_ACCOUNT_REQUIRED',
        );
        expect(await fx.collection('Booking').countDocuments({ user_id: new Types.ObjectId(staff.id) })).toBe(
            0,
        );
    });

    it('refuses a phone outside the supported country and leaves no account behind', async () => {
        expectError(
            await book({ on_behalf: { phone: '380501234567', name: 'Abroad' } }),
            422,
            'PHONE_COUNTRY_NOT_SUPPORTED',
        );
        expectError(await book({ on_behalf: { phone: '12', name: 'Short' } }), 400, 'VALIDATION_ERROR');
        expect(await fx.collection('User').countDocuments({ role: 'common-user' })).toBe(0);
    });

    it('rolls the new account back when the booking itself fails', async () => {
        await book({ on_behalf: { phone: '4915290006666', name: 'Holder' } });
        expectError(await book({ on_behalf: { phone: '4915290007777', name: 'Late' } }), 422, 'SLOT_FULL');

        expect(await fx.collection('User').countDocuments({ phone: '4915290007777' })).toBe(0);
    });
});
