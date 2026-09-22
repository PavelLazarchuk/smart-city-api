import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('bookings as a resource, availability and idempotency (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let client: FixtureUser;
    let bearer: string;
    let adminBearer: string;
    let option: ReturnType<Fixtures['bookableOption']>;
    let serviceId: string;

    const book = (time = '10:00', key?: string) => {
        const request = t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', bearer);

        return (key ? request.set('Idempotency-Key', key) : request).send({
            option_id: option.id,
            slot_id: option.slot_id,
            time,
        });
    };

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
        client = await fx.client({ name: 'Anna', phone: '4915291234567' });
        bearer = await fx.bearer(client);
        adminBearer = await fx.bearer(admin);
        option = fx.bookableOption(3);
        serviceId = (await fx.service(organization.id, { options: [option] })).id;
    });

    describe('GET /bookings, /me/bookings, /services/:id/bookings', () => {
        it('gives the owner their own rows and the organization admin the ones they must serve', async () => {
            expect((await book()).status).toBe(201);

            const own = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', bearer);
            expect(own.status).toBe(200);
            expect(own.body.data).toHaveLength(1);
            expect(own.body.data[0]).toMatchObject({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                time: '10:00',
                person: 'Anna',
            });
            expect(own.body.meta.total).toBe(1);

            const byAdmin = await t.http.get(`${t.prefix}/bookings`).set('Authorization', adminBearer);
            expect(byAdmin.body.data).toHaveLength(1);
            expect(byAdmin.body.data[0].phone).toBe('4915291234567');

            const byService = await t.http
                .get(`${t.prefix}/services/${serviceId}/bookings?option_id=${option.id}`)
                .set('Authorization', adminBearer);
            expect(byService.body.data).toHaveLength(1);

            const bySuper = await t.http
                .get(`${t.prefix}/bookings?service_id=${serviceId}`)
                .set('Authorization', await fx.bearer(await fx.superAdmin()));
            expect(bySuper.body.data).toHaveLength(1);
        });

        it('is closed to clients and scopes an admin to their own organizations', async () => {
            await book();
            const foreignOrganization = await fx.organization();
            const foreign = await fx.bearer(await fx.admin([foreignOrganization.id]));

            expectError(await t.http.get(`${t.prefix}/bookings`).set('Authorization', bearer), 403);
            expect(
                (await t.http.get(`${t.prefix}/bookings`).set('Authorization', foreign)).body.data,
            ).toHaveLength(0);
            expectError(
                await t.http
                    .get(`${t.prefix}/bookings?organization_id=${organization.id}`)
                    .set('Authorization', foreign),
                403,
            );
            expectError(
                await t.http.get(`${t.prefix}/services/${serviceId}/bookings`).set('Authorization', foreign),
                404,
                'SERVICE_NOT_FOUND',
            );
            expectError(await t.http.get(`${t.prefix}/me/bookings`), 401);
        });

        it('answers 404 to an id that is not an object id, for a super-admin too', async () => {
            for (const bearerToken of [adminBearer, await fx.bearer(await fx.superAdmin())]) {
                expectError(
                    await t.http
                        .get(`${t.prefix}/services/not-an-object-id/bookings`)
                        .set('Authorization', bearerToken),
                    404,
                    'SERVICE_NOT_FOUND',
                );
            }
        });

        it('filters by day and cancels without knowing the service id', async () => {
            const created = await book();
            const bookingId = created.body.data.booking_id as string;
            const date = (
                await fx.collection<{ slot_date: string }>('Booking').findOne({ id: bookingId }).lean()
            )?.slot_date;

            const inRange = await t.http
                .get(`${t.prefix}/me/bookings?date_from=${date}&date_to=${date}`)
                .set('Authorization', bearer);
            expect(inRange.body.data).toHaveLength(1);
            const outOfRange = await t.http
                .get(`${t.prefix}/me/bookings?date_from=2000-01-01&date_to=2000-01-02`)
                .set('Authorization', bearer);
            expect(outOfRange.body.data).toHaveLength(0);

            const stranger = await fx.bearer(await fx.client());
            expectError(
                await t.http.delete(`${t.prefix}/bookings/${bookingId}`).set('Authorization', stranger),
                403,
            );
            expect(
                (await t.http.delete(`${t.prefix}/bookings/${bookingId}`).set('Authorization', bearer))
                    .status,
            ).toBe(204);
            expect(
                (await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', bearer)).body.data,
            ).toHaveLength(0);
            expectError(
                await t.http.delete(`${t.prefix}/bookings/${bookingId}`).set('Authorization', bearer),
                422,
                'BOOKING_NOT_ACTIVE',
            );
        });
    });

    describe('GET /services/:id/availability', () => {
        it('answers anonymously with free capacity and no personal data at all', async () => {
            await book();
            const res = await t.http.get(`${t.prefix}/services/${serviceId}/availability`);
            expect(res.status).toBe(200);
            expect(res.headers['cache-control']).toBe('public, max-age=60');
            expect(res.body.data.service_id).toBe(serviceId);
            const slot = res.body.data.options[0].slots[0];
            expect(slot.time).toEqual([{ time: '10:00', limit: 3, booked_count: 1, available: 2 }]);
            expect(JSON.stringify(res.body)).not.toContain('4915291234567');
            expect(JSON.stringify(res.body)).not.toContain('Anna');
        });

        it('hides a service that is not published from anyone who may not see details', async () => {
            const draftId = (
                await fx.service(organization.id, {
                    options: [option],
                    status: 'draft',
                    published_at: null,
                })
            ).id;

            const anonymous = await t.http.get(`${t.prefix}/services/${draftId}/availability`);
            expectError(anonymous, 404, 'SERVICE_NOT_FOUND');

            const outsider = await t.http
                .get(`${t.prefix}/services/${draftId}/availability`)
                .set('Authorization', bearer);
            expectError(outsider, 404, 'SERVICE_NOT_FOUND');

            const owner = await t.http
                .get(`${t.prefix}/services/${draftId}/availability`)
                .set('Authorization', adminBearer);
            expect(owner.status).toBe(200);
            expect(owner.body.data.service_id).toBe(draftId);
            expect(owner.headers['cache-control']).toBe('private, no-store, max-age=0');
        });

        it('keeps only the slots inside the window', async () => {
            const empty = await t.http.get(
                `${t.prefix}/services/${serviceId}/availability?from=2000-01-01&to=2000-01-02`,
            );
            expect(empty.body.data.options).toEqual([]);
            expect(empty.body.data.from).toBe('2000-01-01');
        });
    });

    describe('Idempotency-Key', () => {
        it('replays the first answer instead of answering a retry with a conflict', async () => {
            const first = await book('10:00', 'key-1');
            expect(first.status).toBe(201);

            const retry = await book('10:00', 'key-1');
            expect(retry.status).toBe(201);
            expect(retry.headers['idempotency-replayed']).toBe('true');
            expect(retry.body.data.booking_id).toBe(first.body.data.booking_id);
            expect(await fx.collection('Booking').countDocuments({})).toBe(1);

            const withoutKey = await book('10:00');
            expectError(withoutKey, 409, 'BOOKING_ALREADY_EXISTS');
        });

        it('refuses the same key for a different payload and forgets a failed attempt', async () => {
            await book('10:00', 'key-2');
            const option2 = fx.bookableOption(1, '11:00');
            const other = await fx.service(organization.id, { options: [option2] });
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${other.id}/bookings`)
                    .set('Authorization', bearer)
                    .set('Idempotency-Key', 'key-2')
                    .send({ option_id: option2.id, slot_id: option2.slot_id, time: '11:00' }),
                422,
                'IDEMPOTENCY_KEY_REUSED',
            );

            expectError(
                await t.http
                    .post(`${t.prefix}/services/${serviceId}/bookings`)
                    .set('Authorization', bearer)
                    .set('Idempotency-Key', 'key-3')
                    .send({ option_id: option.id, slot_id: option.slot_id, time: '23:59' }),
                404,
                'SLOT_NOT_FOUND',
            );
            expect(await fx.collection('IdempotencyKey').countDocuments({ key: 'key-3' })).toBe(0);
        });

        it('keeps the claim when the booking committed but the bookkeeping write failed', async () => {
            const keys = fx.collection('IdempotencyKey');
            const failing = jest.spyOn(keys, 'updateOne').mockImplementationOnce(() => {
                throw new Error('bookkeeping write failed');
            });

            expect((await book('10:00', 'key-4')).status).toBe(500);
            failing.mockRestore();

            expect(await fx.collection('Booking').countDocuments({})).toBe(1);
            expect(await keys.countDocuments({ key: 'key-4' })).toBe(1);
            expectError(await book('10:00', 'key-4'), 409, 'IDEMPOTENCY_IN_PROGRESS');
        });
    });
});
