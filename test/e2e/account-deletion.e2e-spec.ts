import { Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

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

describe('account deletion (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let sent: { phone: string; text: string }[];
    let organization: { id: string };
    let adminBearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockImplementation(
            (phone: string, text: string) => {
                sent.push({ phone, text });

                return Promise.resolve();
            },
        );
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        sent = [];
        const config = t.app.get(AppConfig);
        config.auth.adminLoginMethod = 'password';
        config.auth.clientLoginMethod = 'sms';
        organization = await fx.organization();
        adminBearer = await fx.bearer(await fx.admin([organization.id]));
    });

    const lastCode = (): string => sent[sent.length - 1]?.text.split(' ')[0] ?? '';

    const deleteSelf = async (client: FixtureUser): Promise<void> => {
        const bearer = await fx.bearer(client);
        await t.http.post(`${t.prefix}/me/deletion/code`).set('Authorization', bearer).expect(200);
        await t.http
            .delete(`${t.prefix}/me`)
            .set('Authorization', bearer)
            .send({ code: lastCode() })
            .expect(204);
    };

    const book = (
        serviceId: string,
        option: { id: string; slot_id: string },
        bearer: string,
        time = '10:00',
    ) =>
        t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time });

    describe('DELETE /me', () => {
        it('needs the deletion code sent to the account phone and signs every session out', async () => {
            const client = await fx.client();
            const bearer = await fx.bearer(client);
            const elsewhere = await fx.bearer(client);

            const requested = await t.http.post(`${t.prefix}/me/deletion/code`).set('Authorization', bearer);
            expect(requested.status).toBe(200);
            expect(requested.body.data).toEqual({ phone: client.phone, expires_in: 300 });
            expect(sent).toHaveLength(1);
            expect(sent[0]!.phone).toBe(client.phone);
            expect(sent[0]!.text).toContain('deletion of your Smart City account');
            const deletionCode = lastCode();

            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone: client.phone }).expect(200);
            expect(sent).toHaveLength(2);
            expectError(
                await t.http.delete(`${t.prefix}/me`).set('Authorization', bearer).send({ code: lastCode() }),
                422,
                'DELETION_CODE_INVALID',
            );
            expectError(
                await t.http
                    .post(`${t.prefix}/auth/otp/verify`)
                    .send({ phone: client.phone, code: deletionCode }),
                401,
            );
            expectError(
                await t.http.delete(`${t.prefix}/me`).set('Authorization', bearer).send({}),
                400,
                'VALIDATION_ERROR',
            );

            await t.http
                .delete(`${t.prefix}/me`)
                .set('Authorization', bearer)
                .send({ code: deletionCode })
                .expect(204);
            expect(await fx.collection('User').countDocuments({ _id: new Types.ObjectId(client.id) })).toBe(
                0,
            );
            expectError(await t.http.get(`${t.prefix}/auth/me`).set('Authorization', elsewhere), 401);
        });

        it('is for clients, and DELETE /users/:id stays with the super-admin', async () => {
            const client = await fx.client();
            expectError(
                await t.http
                    .delete(`${t.prefix}/users/${client.id}`)
                    .set('Authorization', await fx.bearer(client)),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http.post(`${t.prefix}/me/deletion/code`).set('Authorization', adminBearer),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http
                    .delete(`${t.prefix}/me`)
                    .set('Authorization', adminBearer)
                    .send({ code: '123456' }),
                403,
                'FORBIDDEN',
            );
            expect(sent).toHaveLength(0);
        });
    });

    describe('bookings of a deleted account', () => {
        it('cancels the active ones with an event and hands the place to the waitlist', async () => {
            const option = fx.bookableOption(1);
            const service = await fx.service(organization.id, { options: [option] });
            const leaving = await fx.client({ name: 'Leaving' });
            const waiting = await fx.client({ name: 'Waiting' });
            const held = await book(service.id, option, await fx.bearer(leaving));
            expect(held.status).toBe(201);
            await t.http
                .post(`${t.prefix}/services/${service.id}/waitlist`)
                .set('Authorization', await fx.bearer(waiting))
                .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' })
                .expect(201);

            await deleteSelf(leaving);

            const row = await fx
                .collection<{ status: string; person: string; phone: string; phone_hash?: string }>('Booking')
                .findOne({ id: held.body.data.booking_id as string })
                .lean();
            expect(row).toMatchObject({ status: 'cancelled', person: '', phone: '' });
            expect(row?.phone_hash).toBeUndefined();
            expect((await fx.storedSlot(service.id)).value.time?.[0]).toMatchObject({ booked_count: 0 });

            const events = await fx
                .collection<{ type: string; payload: Record<string, unknown> }>('OutboxEvent')
                .find({ type: { $in: ['booking.cancelled', 'waitlist.slot_available'] } })
                .lean();
            expect(events.find((event) => event.type === 'booking.cancelled')?.payload).toMatchObject({
                booking_id: held.body.data.booking_id,
                user_id: leaving.id,
                status: 'cancelled',
                cancelled_by: 'owner',
                account_deleted: true,
                previous_status: 'confirmed',
            });
            expect(events.find((event) => event.type === 'waitlist.slot_available')?.payload).toMatchObject({
                user_id: waiting.id,
            });
        });

        it('still count toward the minimum interval of the next account on that phone', async () => {
            const phone = '4915290000555';
            const option = fx.bookableOption(5, '10:00');
            option.slots[0]!.value.time!.push({ time: '11:00', limit: 5, booked_count: 0 });
            const service = await fx.service(organization.id, {
                options: [option],
                booking_policy: policy({ min_interval_days: 7 }),
            });
            const first = await fx.client({ phone });
            const visited = await book(service.id, option, await fx.bearer(first));
            await t.http
                .patch(`${t.prefix}/bookings/${visited.body.data.booking_id as string}/status`)
                .set('Authorization', adminBearer)
                .send({ status: 'completed' })
                .expect(200);

            await deleteSelf(first);

            const kept = await fx
                .collection<{ phone: string; phone_hash?: string }>('Booking')
                .findOne({ id: visited.body.data.booking_id as string })
                .lean();
            expect(kept?.phone).toBe('');
            expect(kept?.phone_hash).toMatch(/^[0-9a-f]{64}$/);

            const second = await fx.client({ phone });
            const refused = await book(service.id, option, await fx.bearer(second), '11:00');
            expectError(refused, 422, 'BOOKING_TOO_FREQUENT');

            const stranger = await fx.client();
            expect((await book(service.id, option, await fx.bearer(stranger), '11:00')).status).toBe(201);
        });
    });

    describe('suspensions of a deleted account', () => {
        it('counts a deletion inside the cancel deadline as a late cancel', async () => {
            const phone = '4915290000888';
            const option = fx.bookableOption(5);
            const service = await fx.service(organization.id, {
                options: [option],
                booking_policy: policy({
                    cancel_deadline_minutes: 3 * 24 * 60,
                    no_show_limit: 1,
                    no_show_suspension_days: 30,
                }),
            });
            const first = await fx.client({ phone });
            const held = await book(service.id, option, await fx.bearer(first));
            expect(held.status).toBe(201);

            await deleteSelf(first);

            expect(
                await fx
                    .collection<{ status: string; late_cancel: boolean }>('Booking')
                    .findOne({ id: held.body.data.booking_id as string })
                    .lean(),
            ).toMatchObject({ status: 'cancelled', late_cancel: true });
            const second = await fx.client({ phone });
            expectError(await book(service.id, option, await fx.bearer(second)), 422, 'BOOKING_SUSPENDED');
        });

        it('keep the one in force for the phone until it ends or is lifted, and drop the rest', async () => {
            const phone = '4915290000777';
            const option = fx.bookableOption(5);
            const otherOption = fx.bookableOption(5);
            const service = await fx.service(organization.id, { options: [option] });
            const other = await fx.service(organization.id, { options: [otherOption] });
            const first = await fx.client({ phone });
            const suspend = (serviceId: string) =>
                t.http.post(`${t.prefix}/suspensions`).set('Authorization', adminBearer).send({
                    service_id: serviceId,
                    user_id: first.id,
                    reason: 'Rude to staff',
                    notify: false,
                });
            expect((await suspend(service.id)).status).toBe(201);
            const lifted = (await suspend(other.id)).body.data.id as string;
            await t.http
                .delete(`${t.prefix}/suspensions/${lifted}`)
                .set('Authorization', adminBearer)
                .expect(204);

            await deleteSelf(first);

            const rows = await fx.collection<{ phone_hash?: string }>('BookingSuspension').find({}).lean();
            expect(rows).toHaveLength(1);
            expect(rows[0]!.phone_hash).toMatch(/^[0-9a-f]{64}$/);
            expect(JSON.stringify(rows)).not.toContain(phone);

            const second = await fx.client({ phone });
            const secondBearer = await fx.bearer(second);
            expectError(await book(service.id, option, secondBearer), 422, 'BOOKING_SUSPENDED');
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${service.id}/waitlist`)
                    .set('Authorization', secondBearer)
                    .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' }),
                422,
                'BOOKING_SUSPENDED',
            );
            expect((await book(other.id, otherOption, secondBearer)).status).toBe(201);
            expect((await book(service.id, option, await fx.bearer(await fx.client()))).status).toBe(201);

            const listed = await t.http
                .get(`${t.prefix}/suspensions?user_id=${second.id}`)
                .set('Authorization', adminBearer);
            expect(listed.body.data).toHaveLength(1);
            expect(listed.body.data[0]).toMatchObject({
                user_id: first.id,
                account_deleted: true,
                active: true,
            });

            await t.http
                .delete(`${t.prefix}/suspensions/${listed.body.data[0].id as string}`)
                .set('Authorization', adminBearer)
                .expect(204);
            expect(await fx.collection('BookingSuspension').countDocuments({})).toBe(0);
            expect((await book(service.id, option, secondBearer)).status).toBe(201);
        });
    });
});
