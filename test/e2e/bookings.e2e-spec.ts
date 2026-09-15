import { Types } from 'mongoose';

import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('bookings (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let mailSpy: jest.SpyInstance;

    const timeEntry = async (serviceId: string, index = 0) => {
        const stored = await fx
            .collection<{ options: { slots: { value: { time: { booked_count: number }[] } }[] }[] }>(
                'Service',
            )
            .findById(serviceId)
            .lean();

        return stored!.options[0]!.slots[0]!.value.time[index]!;
    };

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        mailSpy = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        mailSpy.mockClear();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
    });

    it('requires authentication and rejects anonymous bookings', async () => {
        const option = fx.bookableOption(1);
        const service = await fx.service(organization.id, { options: [option] });
        expectError(
            await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' }),
            401,
            'UNAUTHENTICATED',
        );
    });

    it('books a date_time slot, writes the user reference, notifies the subscriber after commit', async () => {
        const option = fx.bookableOption(2);
        const service = await fx.service(organization.id, {
            options: [option],
            value: { heading_value: 'Therapist', subscribe: 'clinic@example.com' },
        });
        const citizen = await fx.citizen({ name: 'Anna' });
        const bearer = await fx.bearer(citizen);

        const res = await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00', info: 'first visit' });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            service_id: service.id,
            option_id: option.id,
            slot_id: option.slot_id,
            time: '10:00',
            child_type: 'date_time',
        });

        expect(await timeEntry(service.id)).toMatchObject({ booked_count: 1 });
        const rows = await fx
            .collection<{ person: string; info: string; slot_time: string }>('Booking')
            .find({ service_id: new Types.ObjectId(service.id) })
            .lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ person: 'Anna', info: 'first visit', slot_time: '10:00' });
        const embedded = await fx
            .collection<{ options: { slots: { value: Record<string, unknown> }[] }[] }>('Service')
            .findById(service.id)
            .lean();
        expect(JSON.stringify(embedded!.options)).not.toContain('Anna');

        const refs = await t.http
            .get(`${t.prefix}/users/${citizen.id}/bookings`)
            .set('Authorization', bearer);
        expect(refs.body.data).toHaveLength(1);
        expect(refs.body.data[0]).toMatchObject({
            id: res.body.data.booking_id,
            service_id: service.id,
            time: '10:00',
        });

        await waitFor(() => Promise.resolve(mailSpy.mock.calls.length === 1));
        expect(mailSpy.mock.calls[0]![0]).toMatchObject({ to: ['clinic@example.com'] });

        const duplicate = await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', bearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        expectError(duplicate, 409, 'BOOKING_ALREADY_EXISTS');

        const asAdmin = await t.http
            .get(`${t.prefix}/services/${service.id}`)
            .set('Authorization', await fx.bearer(admin));
        expect(asAdmin.body.data.options[0].slots[0].value.time[0].bookings[0].person).toBe('Anna');
        const asPublic = await t.http.get(`${t.prefix}/services/${service.id}`);
        expect(asPublic.body.data.options[0].slots[0].value.time[0].bookings).toEqual([
            { status: 'reserved' },
        ]);
        const listPublic = await t.http.get(`${t.prefix}/services`);
        expect(JSON.stringify(listPublic.body)).not.toContain('Anna');
    });

    it('enforces capacity under N parallel bookings: exactly k accepted, the rest 422 SLOT_FULL, no mail for failures', async () => {
        const k = 3;
        const n = 10;
        const option = fx.bookableOption(k);
        const service = await fx.service(organization.id, {
            options: [option],
            value: { subscribe: 'clinic@example.com' },
        });
        const citizens = await Promise.all(Array.from({ length: n }, () => fx.citizen()));
        const bearers = await Promise.all(citizens.map((citizen) => fx.bearer(citizen)));

        const results = await Promise.all(
            bearers.map((bearer) =>
                t.http
                    .post(`${t.prefix}/services/${service.id}/bookings`)
                    .set('Authorization', bearer)
                    .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' }),
            ),
        );
        const accepted = results.filter((res) => res.status === 201);
        const full = results.filter((res) => res.status === 422 && res.body.error.code === 'SLOT_FULL');
        const unexpected = results
            .filter((res) => !accepted.includes(res) && !full.includes(res))
            .map((res) => [res.status, res.body]);
        expect(unexpected).toEqual([]);
        expect(accepted).toHaveLength(k);
        expect(full).toHaveLength(n - k);

        expect(await timeEntry(service.id)).toMatchObject({ booked_count: k });
        expect(await fx.collection('Booking').countDocuments({})).toBe(k);
        await waitFor(() => Promise.resolve(mailSpy.mock.calls.length === k));
        expect(mailSpy).toHaveBeenCalledTimes(k);
    });

    it('books apply and date slots, refuses expired dates, disabled options and info-only slots', async () => {
        const applyId = '22222222-2222-4222-8222-222222222222';
        const dateId = '33333333-3333-4333-8333-333333333333';
        const expiredId = '44444444-4444-4444-8444-444444444444';
        const infoId = '55555555-5555-4555-8555-555555555555';
        const optionId = '66666666-6666-4666-8666-666666666666';
        const disabledId = '77777777-7777-4777-8777-777777777777';
        const service = await fx.service(organization.id, {
            options: [
                {
                    id: optionId,
                    label: 'Apply',
                    service_type: 'service_apply',
                    enabled: true,
                    slots: [
                        {
                            id: applyId,
                            label: 'a',
                            child_type: 'apply',
                            value: { limit: null, booked_count: 0 },
                        },
                        {
                            id: dateId,
                            label: 'd',
                            child_type: 'date',
                            value: { date: '2999-01-01', limit: 1, booked_count: 0 },
                        },
                        {
                            id: expiredId,
                            label: 'e',
                            child_type: 'date',
                            value: { date: '2000-01-01', limit: 1, booked_count: 0 },
                        },
                        { id: infoId, label: 'i', child_type: 'delivery', value: { description: 'x' } },
                    ],
                },
                {
                    id: disabledId,
                    label: 'Off',
                    service_type: 'service_apply',
                    enabled: false,
                    slots: [
                        {
                            id: '88888888-8888-4888-8888-888888888888',
                            label: 'a',
                            child_type: 'apply',
                            value: { limit: null, booked_count: 0 },
                        },
                    ],
                },
            ],
        });
        const citizen = await fx.citizen();
        const bearer = await fx.bearer(citizen);
        const post = (body: Record<string, unknown>) =>
            t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', bearer)
                .send(body);

        expect((await post({ option_id: optionId, slot_id: applyId })).status).toBe(201);
        expect((await post({ option_id: optionId, slot_id: dateId })).status).toBe(201);
        expectError(await post({ option_id: optionId, slot_id: expiredId }), 422, 'SLOT_EXPIRED');
        expectError(await post({ option_id: optionId, slot_id: infoId }), 422, 'SLOT_NOT_BOOKABLE');
        expectError(
            await post({ option_id: disabledId, slot_id: '88888888-8888-4888-8888-888888888888' }),
            422,
            'OPTION_DISABLED',
        );
        expectError(
            await post({ option_id: optionId, slot_id: '99999999-9999-4999-8999-999999999999' }),
            404,
            'SLOT_NOT_FOUND',
        );
        const other = await fx.bearer(await fx.citizen());
        expectError(
            await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', other)
                .send({ option_id: optionId, slot_id: dateId }),
            422,
            'SLOT_FULL',
        );
        expectError(
            await post({ option_id: optionId, slot_id: applyId, time: '10:00' }),
            409,
            'BOOKING_ALREADY_EXISTS',
        );
    });

    it('cancellation: owner or organization admin, never a stranger; updates both sides', async () => {
        const option = fx.bookableOption(2);
        const service = await fx.service(organization.id, { options: [option] });
        const owner = await fx.citizen();
        const ownerBearer = await fx.bearer(owner);
        const created = await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', ownerBearer)
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        const bookingId = created.body.data.booking_id as string;

        const stranger = await fx.bearer(await fx.citizen());
        const foreignAdmin = await fx.bearer(await fx.admin([(await fx.organization()).id]));
        expectError(
            await t.http
                .delete(`${t.prefix}/services/${service.id}/bookings/${bookingId}`)
                .set('Authorization', stranger),
            403,
        );
        expectError(
            await t.http
                .delete(`${t.prefix}/services/${service.id}/bookings/${bookingId}`)
                .set('Authorization', foreignAdmin),
            403,
        );

        const cancelled = await t.http
            .delete(`${t.prefix}/services/${service.id}/bookings/${bookingId}`)
            .set('Authorization', await fx.bearer(admin));
        expect(cancelled.status).toBe(204);
        expect(await timeEntry(service.id)).toMatchObject({ booked_count: 0 });
        expect(await fx.collection('Booking').countDocuments({ active: true })).toBe(0);
        expect(await fx.collection('Booking').countDocuments({ status: 'cancelled' })).toBe(1);
        const refs = await t.http
            .get(`${t.prefix}/users/${owner.id}/bookings`)
            .set('Authorization', ownerBearer);
        expect(refs.body.data).toEqual([]);
        const history = await t.http
            .get(`${t.prefix}/me/bookings?status=cancelled`)
            .set('Authorization', ownerBearer);
        expect(history.body.data).toHaveLength(1);
        expect(history.body.data[0]).toMatchObject({ id: bookingId, status: 'cancelled' });
        expectError(
            await t.http
                .delete(`${t.prefix}/services/${service.id}/bookings/${bookingId}`)
                .set('Authorization', ownerBearer),
            422,
            'BOOKING_NOT_ACTIVE',
        );
    });

    it('cancelling twice does not decrement the counter twice', async () => {
        const option = fx.bookableOption(2);
        const service = await fx.service(organization.id, { options: [option] });
        const owner = await fx.citizen();
        const bearer = await fx.bearer(owner);
        const book = () =>
            t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', bearer)
                .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        const entry = () => timeEntry(service.id);

        const created = await book();
        const bookingId = created.body.data.booking_id as string;
        expect(await entry()).toMatchObject({ booked_count: 1 });

        const cancel = () =>
            t.http
                .delete(`${t.prefix}/services/${service.id}/bookings/${bookingId}`)
                .set('Authorization', bearer);
        expect((await cancel()).status).toBe(204);
        expect(await entry()).toMatchObject({ booked_count: 0 });
        expectError(await cancel(), 422, 'BOOKING_NOT_ACTIVE');
        expect(await entry()).toMatchObject({ booked_count: 0 });

        for (let i = 0; i < 2; i += 1) {
            const again = await book();
            expect(again.status).toBe(201);
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/services/${service.id}/bookings/${again.body.data.booking_id}`)
                        .set('Authorization', bearer)
                ).status,
            ).toBe(204);
        }

        expect(await entry()).toMatchObject({ booked_count: 0 });
    });

    it('renaming a booked time in PATCH /services/:id keeps the booking', async () => {
        const option = fx.bookableOption(2, '10:00');
        const service = await fx.service(organization.id, { options: [option] });
        const owner = await fx.citizen();
        const created = await t.http
            .post(`${t.prefix}/services/${service.id}/bookings`)
            .set('Authorization', await fx.bearer(owner))
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        expect(created.status).toBe(201);

        const slot = option.slots[0]!;
        const patched = await t.http
            .patch(`${t.prefix}/services/${service.id}`)
            .set('Authorization', await fx.bearer(admin))
            .send({
                options: [
                    {
                        id: option.id,
                        label: option.label,
                        service_type: option.service_type,
                        enabled: option.enabled,
                        slots: [
                            {
                                id: slot.id,
                                label: slot.label,
                                child_type: 'date_time',
                                value: { date: slot.value.date, time: [{ time: '10:30', limit: 2 }] },
                            },
                        ],
                    },
                ],
            });
        expect(patched.status).toBe(200);
        const times = patched.body.data.options[0].slots[0].value.time as {
            time: string;
            booked_count: number;
            bookings: unknown[];
        }[];
        expect(times.map((time) => time.time)).toEqual(['10:30', '10:00']);
        expect(times[1]).toMatchObject({ booked_count: 1 });
        const refs = await t.http
            .get(`${t.prefix}/users/${owner.id}/bookings`)
            .set('Authorization', await fx.bearer(owner));
        expect(refs.body.data).toHaveLength(1);
    });

    it('deleting the service or the user removes the bookings on the other side', async () => {
        const option = fx.bookableOption(5);
        const service = await fx.service(organization.id, { options: [option] });
        const a = await fx.citizen();
        const b = await fx.citizen();

        for (const citizen of [a, b]) {
            await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', await fx.bearer(citizen))
                .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        }

        const superAdmin = await fx.superAdmin();
        expect(
            (
                await t.http
                    .delete(`${t.prefix}/users/${a.id}`)
                    .set('Authorization', await fx.bearer(superAdmin))
            ).status,
        ).toBe(204);
        expect(await timeEntry(service.id)).toMatchObject({ booked_count: 1 });
        const remaining = await fx.collection<{ user_id: Types.ObjectId }>('Booking').find({}).lean();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.user_id.toHexString()).toBe(b.id);

        expect(
            (
                await t.http
                    .delete(`${t.prefix}/services/${service.id}`)
                    .set('Authorization', await fx.bearer(admin))
            ).status,
        ).toBe(204);
        expect(
            (await fx.collection<{ deleted_at: Date | null }>('Service').findById(service.id).lean())
                ?.deleted_at,
        ).toBeInstanceOf(Date);
        expect(await fx.collection('Booking').countDocuments({})).toBe(1);

        expect(
            (
                await t.http
                    .delete(`${t.prefix}/services/${service.id}?permanent=true`)
                    .set('Authorization', await fx.bearer(superAdmin))
            ).status,
        ).toBe(204);
        expect(await fx.collection('Service').findById(service.id).lean()).toBeNull();
        expect(await fx.collection('Booking').countDocuments({})).toBe(0);
    });
});
