import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('operator role (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let operatorBearer: string;
    let client: FixtureUser;
    let option: ReturnType<Fixtures['bookableOption']>;
    let serviceId: string;
    let bookingId: string;

    const as = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, bearer = operatorBearer) =>
        t.http[method](`${t.prefix}${path}`).set('Authorization', bearer);

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        operatorBearer = await fx.bearer(
            await fx.user({ role: 'operator', organization_ids: [organization.id] }),
        );
        client = await fx.client();
        option = fx.bookableOption(3);
        serviceId = (await fx.service(organization.id, { options: [option] })).id;
        bookingId = (
            await fx.booking({
                service_id: serviceId,
                organization_id: organization.id,
                option_id: option.id,
                slot_id: option.slot_id,
                user_id: client.id,
                time: '10:00',
            })
        ).id;
    });

    it('works the bookings of its organization', async () => {
        expect((await as('get', `/services/${serviceId}/bookings`)).body.data).toHaveLength(1);
        expect((await as('get', '/bookings')).body.data).toHaveLength(1);
        expect((await as('get', '/bookings/stats')).status).toBe(200);
        expect((await as('get', `/bookings/${bookingId}`)).body.data.phone).toBeTruthy();
        expect((await as('get', `/services/${serviceId}/waitlist`)).status).toBe(200);

        const walkIn = await as('post', `/services/${serviceId}/bookings`).send({
            option_id: option.id,
            slot_id: option.slot_id,
            time: '10:00',
            on_behalf: { phone: '4915290007777', name: 'Walk-in' },
        });
        expect(walkIn.status).toBe(201);
        expect(walkIn.body.data.status).toBe('confirmed');

        expect(
            (await as('patch', `/bookings/${bookingId}/status`).send({ status: 'completed' })).status,
        ).toBe(200);
    });

    it('lists the clients of its organization and writes to them', async () => {
        const clients = await as('get', `/organizations/${organization.id}/clients`);
        expect(clients.body.data.map((row: { user_id: string }) => row.user_id)).toEqual([client.id]);

        const sent = await as('post', `/organizations/${organization.id}/messages`).send({
            user_id: client.id,
            body: 'Please bring your passport.',
        });
        expect(sent.status).toBe(201);
    });

    it('cancels the bookings of a slot but may not remove the slot', async () => {
        const path = `/services/${serviceId}/options/${option.id}/slots/${option.slot_id}/cancel`;

        expectError(await as('post', path).send({ remove: true }), 403, 'FORBIDDEN');

        const res = await as('post', path).send({ reason: 'Doctor is ill' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ cancelled: 1, removed: false });
    });

    it('manages the news of its organization', async () => {
        const created = await as('post', '/news').send({
            organization_id: organization.id,
            label: 'Closed on Monday',
        });
        expect(created.status).toBe(201);

        const id = created.body.data.id as string;
        expect((await as('patch', `/news/${id}`).send({ label: 'Closed on Tuesday' })).status).toBe(200);
        expect((await as('delete', `/news/${id}`)).status).toBe(204);

        const foreign = await fx.organization();
        expectError(
            await as('post', '/news').send({ organization_id: foreign.id, label: 'x' }),
            403,
            'FORBIDDEN',
        );
    });

    it('may not touch the catalogue', async () => {
        const refused: [Parameters<typeof as>[0], string, object?][] = [
            ['patch', `/services/${serviceId}`, { label: 'x' }],
            ['put', `/services/${serviceId}/status`, { status: 'archived' }],
            ['delete', `/services/${serviceId}`],
            ['get', `/services/${serviceId}/history`],
            ['post', `/services/${serviceId}/options`, { label: 'x', service_type: 'service_apply' }],
            ['delete', `/services/${serviceId}/options/${option.id}/slots/${option.slot_id}`],
            ['post', '/services', { organization_id: organization.id, label: 'x' }],
            ['post', '/categories', { organization_id: organization.id, label: 'x' }],
            ['patch', `/organizations/${organization.id}`, { main_label: 'x' }],
            ['patch', `/organizations/${organization.id}/services/order`, { ids: [serviceId] }],
            ['get', '/webhooks'],
            ['get', '/archives'],
            ['get', '/users'],
        ];

        for (const [method, path, body] of refused) {
            const res = await (body ? as(method, path).send(body) : as(method, path));

            expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
        }
    });

    it('sees nothing of another organization', async () => {
        const stranger = await fx.bearer(
            await fx.user({ role: 'operator', organization_ids: [(await fx.organization()).id] }),
        );

        expectError(await as('get', `/services/${serviceId}/bookings`, stranger), 404, 'SERVICE_NOT_FOUND');
        expectError(
            await as('patch', `/bookings/${bookingId}/status`, stranger).send({ status: 'completed' }),
            404,
            'BOOKING_NOT_FOUND',
        );
        expect((await as('get', '/bookings', stranger)).body.data).toEqual([]);
    });

    it('sees the drafts and scheduled news of its own organization only', async () => {
        const draft = await fx.service(organization.id, { status: 'draft' });
        expect((await as('get', `/services/${draft.id}`)).status).toBe(200);
        expectError(
            await as('get', `/services/${draft.id}`, await fx.bearer(client)),
            404,
            'SERVICE_NOT_FOUND',
        );

        const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const own = await fx.news(organization.id, { publish_at: later });
        const foreign = await fx.news((await fx.organization()).id, { publish_at: later });
        const ids = ((await as('get', '/news?limit=100')).body.data as { id: string }[]).map(
            (item) => item.id,
        );

        expect(ids).toContain(own.id);
        expect(ids).not.toContain(foreign.id);
    });
});
