import { ROLES } from '../../src/common/decorators/roles.decorator';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('sensitive form fields (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let client: FixtureUser;
    let clientBearer: string;

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
        client = await fx.client();
        clientBearer = await fx.bearer(client);
    });

    const bookedService = async () => {
        const option = fx.bookableOption(5);
        const created = await t.http
            .post(`${t.prefix}/services`)
            .set('Authorization', adminBearer)
            .send({
                organization_id: organization.id,
                label: 'Certificate',
                status: 'published',
                form_fields: [
                    { key: 'tax_id', label: 'Tax number', type: 'text', sensitive: true },
                    { key: 'city', label: 'City', type: 'text' },
                ],
            });
        expect(created.status).toBe(201);
        expect(created.body.data.form_fields).toEqual([
            expect.objectContaining({ key: 'tax_id', sensitive: true }),
            expect.objectContaining({ key: 'city', sensitive: false }),
        ]);
        const serviceId = created.body.data.id as string;
        const { slot_id: _slot, ...optionBody } = option;
        const added = await t.http
            .post(`${t.prefix}/services/${serviceId}/options`)
            .set('Authorization', adminBearer)
            .send({ ...optionBody, id: undefined });
        expect(added.status).toBe(201);
        const stored = added.body.data.options[0] as { id: string; slots: { id: string }[] };
        const booked = await t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', clientBearer)
            .send({
                option_id: stored.id,
                slot_id: stored.slots[0]!.id,
                time: '10:00',
                fields: { tax_id: '3012345678', city: 'Kyiv' },
            });
        expect(booked.status).toBe(201);

        return { serviceId, bookingId: booked.body.data.booking_id as string };
    };

    it('masks sensitive answers in lists and shows them in full only on the booking card', async () => {
        const { serviceId, bookingId } = await bookedService();
        const masked = { tax_id: '****78', city: 'Kyiv' };

        const staffList = await t.http.get(`${t.prefix}/bookings`).set('Authorization', adminBearer);
        expect(staffList.body.data[0].fields).toEqual(masked);

        const serviceList = await t.http
            .get(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', adminBearer);
        expect(serviceList.body.data[0].fields).toEqual(masked);

        const ownList = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', clientBearer);
        expect(ownList.body.data[0].fields).toEqual(masked);

        const card = await t.http.get(`${t.prefix}/bookings/${bookingId}`).set('Authorization', adminBearer);
        expect(card.body.data.fields).toEqual({ tax_id: '3012345678', city: 'Kyiv' });
    });

    it('masks the export for admins and leaves the answers out for operators', async () => {
        await bookedService();
        const operator = await fx.user({ role: ROLES.OPERATOR, organization_ids: [organization.id] });

        const forAdmin = await t.http
            .get(`${t.prefix}/bookings/export.csv`)
            .set('Authorization', adminBearer);
        expect(forAdmin.text).toContain('****78');
        expect(forAdmin.text).toContain('Kyiv');
        expect(forAdmin.text).not.toContain('3012345678');

        const forOperator = await t.http
            .get(`${t.prefix}/bookings/export.csv`)
            .set('Authorization', await fx.bearer(operator));
        expect(forOperator.status).toBe(200);
        expect(forOperator.text).not.toContain('Kyiv');
        expect(forOperator.text).not.toContain('****78');
    });
});
