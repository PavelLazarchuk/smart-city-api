import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('suspensions administration (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let adminBearer: string;
    let superBearer: string;
    let serviceId: string;
    let client: FixtureUser;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        jest.restoreAllMocks();
        organization = await fx.organization();
        adminBearer = await fx.bearer(await fx.admin([organization.id]));
        superBearer = await fx.bearer(await fx.superAdmin());
        serviceId = (await fx.service(organization.id, { value: { heading_value: 'Dentist' } })).id;
        client = await fx.client({ name: 'Anna' });
    });

    const suspend = (body: Record<string, unknown>, bearer = adminBearer) =>
        t.http
            .post(`${t.prefix}/suspensions`)
            .set('Authorization', bearer)
            .send({ service_id: serviceId, reason: 'Rude to staff', ...body });

    const list = (query: string, bearer = adminBearer) =>
        t.http.get(`${t.prefix}/suspensions${query}`).set('Authorization', bearer);

    const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((row) => row.id).sort();

    it('finds the client by phone and names the service by its heading', async () => {
        const created = await suspend({ phone: client.phone, days: 3 });

        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({
            user_id: client.id,
            service_id: serviceId,
            organization_id: organization.id,
            service_label: 'Dentist',
            kind: 'manual',
            reason: 'Rude to staff',
            active: true,
            booking_ids: [],
            lifted_at: null,
        });
        expect(Date.parse(created.body.data.until as string)).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    });

    it('filters by client and service and shows lifted rows only with status all', async () => {
        const other = await fx.client();
        const otherService = (await fx.service(organization.id)).id;
        const first = (await suspend({ user_id: client.id })).body.data.id as string;
        const second = (await suspend({ user_id: other.id })).body.data.id as string;
        const third = (await suspend({ user_id: client.id, service_id: otherService })).body.data
            .id as string;

        expect(ids(await list(`?user_id=${client.id}`))).toEqual([first, third].sort());
        expect(ids(await list(`?service_id=${otherService}`))).toEqual([third]);

        expect(
            (await t.http.delete(`${t.prefix}/suspensions/${second}`).set('Authorization', adminBearer))
                .status,
        ).toBe(204);
        expect(ids(await list(''))).toEqual([first, third].sort());

        const all = await list('?status=all');
        expect(ids(all)).toEqual([first, second, third].sort());
        const lifted = all.body.data.find((row: { id: string }) => row.id === second);
        expect(lifted).toMatchObject({ active: false, lifted_by: expect.any(String) });
        expect(lifted.lifted_at).not.toBeNull();
    });

    it('answers a lift of a lifted suspension without changing it again', async () => {
        const id = (await suspend({ user_id: client.id })).body.data.id as string;
        const lift = () => t.http.delete(`${t.prefix}/suspensions/${id}`).set('Authorization', adminBearer);

        expect((await lift()).status).toBe(204);
        const firstLift = (
            await t.http.get(`${t.prefix}/suspensions/${id}`).set('Authorization', adminBearer)
        ).body.data.lifted_at as string;
        expect((await lift()).status).toBe(204);
        const after = await t.http.get(`${t.prefix}/suspensions/${id}`).set('Authorization', adminBearer);
        expect(after.body.data.lifted_at).toBe(firstLift);
        expectError(
            await t.http.delete(`${t.prefix}/suspensions/unknown-id`).set('Authorization', adminBearer),
            404,
            'SUSPENSION_NOT_FOUND',
        );
    });

    it('scopes a super-admin by organization only when asked and refuses a foreign one to an admin', async () => {
        const other = await fx.organization();
        const foreignService = (await fx.service(other.id)).id;
        const own = (await suspend({ user_id: client.id })).body.data.id as string;
        const foreign = (await suspend({ user_id: client.id, service_id: foreignService }, superBearer)).body
            .data.id as string;

        expect(ids(await list('', superBearer))).toEqual([own, foreign].sort());
        expect(ids(await list(`?organization_id=${other.id}`, superBearer))).toEqual([foreign]);
        expect(ids(await list(`?organization_id=${organization.id}`))).toEqual([own]);
        expectError(await list(`?organization_id=${other.id}`), 403, 'FORBIDDEN');
        expect(
            (await t.http.get(`${t.prefix}/suspensions/${foreign}`).set('Authorization', superBearer)).status,
        ).toBe(200);
    });

    it('refuses a deleted service', async () => {
        await fx
            .collection('Service')
            .updateOne({ label: { $exists: true } }, { $set: { deleted_at: new Date() } });

        expectError(await suspend({ user_id: client.id }), 404, 'SERVICE_NOT_FOUND');
    });

    it('tells a client without e-mail by SMS and one with e-mail by mail only', async () => {
        const sms = jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockResolvedValue(undefined);
        const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
        const withEmail = await fx.client({ email: 'mailed@example.com' });

        expect((await suspend({ user_id: client.id, days: 5 })).status).toBe(201);
        await waitFor(() => Promise.resolve(sms.mock.calls.length === 1));
        expect(sms.mock.calls[0]![0]).toBe(client.phone);
        expect(sms.mock.calls[0]![1]).toContain('Dentist');

        expect((await suspend({ user_id: withEmail.id })).status).toBe(201);
        await waitFor(() => Promise.resolve(mail.mock.calls.length === 1));
        expect(mail.mock.calls[0]![0].to).toEqual(['mailed@example.com']);
        await waitFor(
            async () =>
                (await fx.collection('OutboxEvent').countDocuments({ status: { $ne: 'delivered' } })) === 0,
        );
        expect(sms).toHaveBeenCalledTimes(1);
    });
});
