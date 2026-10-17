import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { TrashPurgeJob } from '../../src/jobs/trash-purge.job';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('catalogue deletion with live bookings (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let bearer: string;
    let superBearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
        bearer = await fx.bearer(admin);
        superBearer = await fx.bearer(await fx.superAdmin());
    });

    const bookedService = async () => {
        const option = fx.bookableOption(5);
        const service = await fx.service(organization.id, { options: [option] });
        const client = await fx.client();
        const booking = await fx.booking({
            service_id: service.id,
            organization_id: organization.id,
            option_id: option.id,
            slot_id: option.slot_id,
            user_id: client.id,
            time: '10:00',
            phone: client.phone,
        });
        await fx.collection('WaitlistEntry').create({
            id: randomUUID(),
            service_id: new Types.ObjectId(service.id),
            organization_id: new Types.ObjectId(organization.id),
            option_id: option.id,
            slot_id: option.slot_id,
            slot_date: null,
            slot_time: '10:00',
            user_id: new Types.ObjectId((await fx.client()).id),
            phone: '4915290000099',
        });

        return { service, booking, client };
    };

    const bookingRow = (id: string) =>
        fx.collection<{ status: string; active: boolean }>('Booking').findOne({ id }).lean();

    const cancelledEvents = () =>
        fx
            .collection<{ payload: Record<string, unknown>; internal: Record<string, unknown> }>(
                'OutboxEvent',
            )
            .find({ type: 'booking.cancelled' })
            .lean();

    describe('services', () => {
        it('refuses to trash a service with active bookings and keeps everything as it was', async () => {
            const { service, booking } = await bookedService();

            expectError(
                await t.http.delete(`${t.prefix}/services/${service.id}`).set('Authorization', bearer),
                409,
                'SERVICE_HAS_BOOKINGS',
            );
            expect((await bookingRow(booking.id))!.active).toBe(true);
            expect(await fx.collection('Service').countDocuments({ deleted_at: { $ne: null } })).toBe(0);
        });

        it('cancels the bookings with notifications when asked, then trashes the service', async () => {
            const { service, booking, client } = await bookedService();

            const res = await t.http
                .delete(`${t.prefix}/services/${service.id}?cancel_bookings=true`)
                .set('Authorization', bearer);

            expect(res.status).toBe(204);
            expect(await bookingRow(booking.id)).toMatchObject({ status: 'cancelled', active: false });
            expect(await fx.collection('WaitlistEntry').countDocuments({})).toBe(0);
            expect((await fx.storedSlot(service.id)).value.time![0]!.booked_count).toBe(0);
            const [event] = await cancelledEvents();
            expect(event!.payload).toMatchObject({
                booking_id: booking.id,
                cancelled_by: 'admin',
                bulk: true,
            });
            expect(event!.internal).toMatchObject({
                notify: true,
                phone: client.phone,
                actor: { id: admin.id, kind: 'staff' },
            });
            const trashed = await fx
                .collection<{ deleted_at: Date | null }>('Service')
                .findById(service.id)
                .lean();
            expect(trashed!.deleted_at).toBeInstanceOf(Date);
        });

        it('applies the same rule to a permanent delete', async () => {
            const { service, booking } = await bookedService();

            expectError(
                await t.http
                    .delete(`${t.prefix}/services/${service.id}?permanent=true`)
                    .set('Authorization', superBearer),
                409,
                'SERVICE_HAS_BOOKINGS',
            );
            expect(
                (
                    await t.http
                        .delete(`${t.prefix}/services/${service.id}?permanent=true&cancel_bookings=true`)
                        .set('Authorization', superBearer)
                ).status,
            ).toBe(204);
            expect(await fx.collection('Service').countDocuments({})).toBe(0);
            expect(await bookingRow(booking.id)).toBeNull();
            expect((await cancelledEvents()).map((event) => event.payload['booking_id'])).toEqual([
                booking.id,
            ]);
        });

        it('lets the trash purge announce bookings left on a trashed service', async () => {
            const { service, booking } = await bookedService();
            await fx
                .collection('Service')
                .updateOne(
                    { _id: new Types.ObjectId(service.id) },
                    { $set: { deleted_at: new Date(Date.now() - 40 * 86_400_000) } },
                );

            await t.app.get(TrashPurgeJob).execute(new Date());

            expect(await fx.collection('Service').countDocuments({})).toBe(0);
            const [event] = await cancelledEvents();
            expect(event!.payload['booking_id']).toBe(booking.id);
            expect(event!.internal['actor']).toBeUndefined();
        });

        it('reorders a category while one of its services is in the trash', async () => {
            const category = await fx.category(organization.id);
            const first = await fx.service(organization.id, { category_id: category.id, position: 0 });
            const second = await fx.service(organization.id, { category_id: category.id, position: 1 });
            const third = await fx.service(organization.id, { category_id: category.id, position: 2 });
            await t.http.delete(`${t.prefix}/services/${second.id}`).set('Authorization', bearer);

            const res = await t.http
                .patch(`${t.prefix}/categories/${category.id}/services/order`)
                .set('Authorization', bearer)
                .send({ ids: [third.id, first.id] });

            expect(res.status).toBe(204);
            const restored = await t.http
                .post(`${t.prefix}/services/${second.id}/restore`)
                .set('Authorization', bearer);
            expect(restored.status).toBe(200);
            expect(restored.body.data.position).toBe(2);
        });
    });

    describe('organizations', () => {
        it('refuses to delete an organization with active bookings unless they are cancelled', async () => {
            const { booking } = await bookedService();
            const remove = (query = '') =>
                t.http
                    .delete(`${t.prefix}/organizations/${organization.id}${query}`)
                    .set('Authorization', superBearer);

            expectError(await remove(), 409, 'ORGANIZATION_HAS_BOOKINGS');
            expect(await fx.collection('Organization').countDocuments({})).toBe(1);

            expect((await remove('?cancel_bookings=true')).status).toBe(204);
            expect(await fx.collection('Organization').countDocuments({})).toBe(0);
            expect((await cancelledEvents()).map((event) => event.payload['booking_id'])).toEqual([
                booking.id,
            ]);
        });
    });
});
