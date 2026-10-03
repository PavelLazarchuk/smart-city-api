import { randomUUID } from 'node:crypto';

import { AppConfig } from '../../src/common/config/app-config';
import { ROLES } from '../../src/common/decorators/roles.decorator';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError, expectNoSensitiveKeys } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('bookings export, profile and service clone (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let sent: { phone: string; code: string }[];

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
        jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockImplementation(
            (phone: string, text: string) => {
                sent.push({ phone, code: text.split(' ')[0] ?? '' });

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
    });

    describe('GET /bookings/export.csv', () => {
        let organization: { id: string };
        let admin: FixtureUser;
        let option: ReturnType<Fixtures['bookableOption']>;
        let serviceId: string;

        const book = async (user: FixtureUser, time: string): Promise<string> => {
            const res = await t.http
                .post(`${t.prefix}/services/${serviceId}/bookings`)
                .set('Authorization', await fx.bearer(user))
                .send({ option_id: option.id, slot_id: option.slot_id, time });
            expect(res.status).toBe(201);

            return res.body.data.booking_id as string;
        };

        beforeEach(async () => {
            organization = await fx.organization();
            admin = await fx.admin([organization.id]);
            option = fx.bookableOption(5, '10:00');
            option.slots[0]!.value.time!.push({ time: '11:00', limit: 5, booked_count: 0 });
            serviceId = (await fx.service(organization.id, { options: [option] })).id;
        });

        it('streams the scoped bookings as CSV with neutralized formulas', async () => {
            const anna = await fx.client({ name: 'Anna, "the first"' });
            const mallory = await fx.client({ name: '=HYPERLINK("http://evil")' });
            const first = await book(anna, '11:00');
            const second = await book(mallory, '10:00');

            const res = await t.http
                .get(`${t.prefix}/bookings/export.csv`)
                .set('Authorization', await fx.bearer(admin));
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
            expect(res.headers['content-disposition']).toBe('attachment; filename="bookings.csv"');
            expect(res.headers['cache-control']).toContain('no-store');
            expect(res.text.startsWith('\uFEFFid,status,service_id,')).toBe(true);

            const lines = res.text.replace('\uFEFF', '').trimEnd().split('\r\n');
            expect(lines).toHaveLength(3);
            expect(lines[1]!.startsWith(`${second},confirmed,${serviceId},`)).toBe(true);
            expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
            expect(lines[2]!.startsWith(`${first},confirmed,`)).toBe(true);
            expect(lines[2]).toContain('"Anna, ""the first"""');
        });

        it('applies the GET /bookings filters and organization scope', async () => {
            const client = await fx.client();
            const kept = await book(client, '10:00');
            const cancelled = await book(await fx.client(), '11:00');
            const cancel = await t.http
                .delete(`${t.prefix}/bookings/${cancelled}`)
                .set('Authorization', await fx.bearer(admin));
            expect(cancel.status).toBe(204);

            const bearer = await fx.bearer(admin);
            const active = await t.http.get(`${t.prefix}/bookings/export.csv`).set('Authorization', bearer);
            expect(active.text).toContain(kept);
            expect(active.text).not.toContain(cancelled);

            const all = await t.http
                .get(`${t.prefix}/bookings/export.csv?status=all`)
                .set('Authorization', bearer);
            expect(all.text).toContain(cancelled);

            const byUser = await t.http
                .get(`${t.prefix}/bookings/export.csv?status=all&user_id=${client.id}`)
                .set('Authorization', bearer);
            expect(byUser.text).toContain(kept);
            expect(byUser.text).not.toContain(cancelled);

            const stranger = await fx.admin([(await fx.organization()).id]);
            const foreign = await t.http
                .get(`${t.prefix}/bookings/export.csv`)
                .set('Authorization', await fx.bearer(stranger));
            expect(foreign.status).toBe(200);
            expect(foreign.text.trimEnd().split('\r\n')).toHaveLength(1);

            expectError(
                await t.http
                    .get(`${t.prefix}/bookings/export.csv?organization_id=${organization.id}`)
                    .set('Authorization', await fx.bearer(stranger)),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http
                    .get(`${t.prefix}/bookings/export.csv`)
                    .set('Authorization', await fx.bearer(client)),
                403,
                'FORBIDDEN',
            );
            expectError(
                await t.http.get(`${t.prefix}/bookings/export.csv?status=bogus`).set('Authorization', bearer),
                400,
                'VALIDATION_ERROR',
            );

            const operator = await fx.user({ role: ROLES.OPERATOR, organization_ids: [organization.id] });
            const byOperator = await t.http
                .get(`${t.prefix}/bookings/export.csv`)
                .set('Authorization', await fx.bearer(operator));
            expect(byOperator.status).toBe(200);
            expect(byOperator.text).toContain(kept);
        });
    });

    describe('PATCH /me', () => {
        it('updates the name and the e-mail and clears the e-mail with null', async () => {
            const client = await fx.client({ email: 'old@example.com' });
            const bearer = await fx.bearer(client);

            const res = await t.http
                .patch(`${t.prefix}/me`)
                .set('Authorization', bearer)
                .send({ name: 'Renamed', email: 'New@Example.com' });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ id: client.id, name: 'Renamed', email: 'new@example.com' });
            expectNoSensitiveKeys(res.body);

            const cleared = await t.http
                .patch(`${t.prefix}/me`)
                .set('Authorization', bearer)
                .send({ email: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.data.email).toBeUndefined();

            expectError(
                await t.http.patch(`${t.prefix}/me`).set('Authorization', bearer).send({ name: '' }),
                400,
                'VALIDATION_ERROR',
            );
            expectError(await t.http.patch(`${t.prefix}/me`).send({ name: 'x' }), 401, 'UNAUTHENTICATED');
        });

        it('changes the phone only with a code sent to the new number and ends the other sessions', async () => {
            const client = await fx.client({ phone: '4915290000001' });
            const current = await fx.bearer(client);
            const other = await fx.bearer(client);
            const phone = '4915290000002';

            expectError(
                await t.http.patch(`${t.prefix}/me`).set('Authorization', current).send({ phone }),
                422,
                'PHONE_CODE_REQUIRED',
            );

            const requested = await t.http
                .post(`${t.prefix}/me/phone/code`)
                .set('Authorization', current)
                .send({ phone });
            expect(requested.status).toBe(200);
            expect(requested.body.data).toEqual({ phone, expires_in: 300 });
            expect(sent).toHaveLength(1);
            expect(sent[0]!.phone).toBe(phone);

            expectError(
                await t.http
                    .patch(`${t.prefix}/me`)
                    .set('Authorization', current)
                    .send({ phone, code: sent[0]!.code === '000000' ? '111111' : '000000' }),
                422,
                'PHONE_CODE_INVALID',
            );

            const changed = await t.http
                .patch(`${t.prefix}/me`)
                .set('Authorization', current)
                .send({ phone, code: sent[0]!.code, name: 'Moved' });
            expect(changed.status).toBe(200);
            expect(changed.body.data).toMatchObject({ phone, name: 'Moved' });

            expect((await t.http.get(`${t.prefix}/auth/me`).set('Authorization', current)).status).toBe(200);
            expectError(await t.http.get(`${t.prefix}/auth/me`).set('Authorization', other), 401);

            expectError(
                await t.http
                    .patch(`${t.prefix}/me`)
                    .set('Authorization', current)
                    .send({ phone: '4915290000003', code: sent[0]!.code }),
                422,
                'PHONE_CODE_INVALID',
            );

            const same = await t.http.patch(`${t.prefix}/me`).set('Authorization', current).send({ phone });
            expect(same.status).toBe(200);
        });

        it('keeps login codes and phone-change codes apart and binds them to the requester', async () => {
            const client = await fx.client();
            const bearer = await fx.bearer(client);
            const phone = '4915290000010';

            await t.http.post(`${t.prefix}/auth/otp/request`).send({ phone });
            expect(sent).toHaveLength(1);
            expectError(
                await t.http
                    .patch(`${t.prefix}/me`)
                    .set('Authorization', bearer)
                    .send({ phone, code: sent[0]!.code }),
                422,
                'PHONE_CODE_INVALID',
            );

            await t.http.post(`${t.prefix}/me/phone/code`).set('Authorization', bearer).send({ phone });
            expect(sent).toHaveLength(2);
            expectError(
                await t.http.post(`${t.prefix}/auth/otp/verify`).send({ phone, code: sent[1]!.code }),
                401,
            );

            const intruder = await fx.client();
            expectError(
                await t.http
                    .patch(`${t.prefix}/me`)
                    .set('Authorization', await fx.bearer(intruder))
                    .send({ phone, code: sent[1]!.code }),
                422,
                'PHONE_CODE_INVALID',
            );

            const own = await t.http
                .patch(`${t.prefix}/me`)
                .set('Authorization', bearer)
                .send({ phone, code: sent[1]!.code });
            expect(own.status).toBe(200);
            expect(own.body.data.phone).toBe(phone);
        });

        it('sends nothing to a number another account owns and answers the same way', async () => {
            const owner = await fx.client({ phone: '4915290000020' });
            const client = await fx.client();
            const bearer = await fx.bearer(client);

            const res = await t.http
                .post(`${t.prefix}/me/phone/code`)
                .set('Authorization', bearer)
                .send({ phone: owner.phone });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ phone: owner.phone, expires_in: 300 });
            expect(sent).toHaveLength(0);

            expectError(
                await t.http
                    .patch(`${t.prefix}/me`)
                    .set('Authorization', bearer)
                    .send({ phone: owner.phone, code: '123456' }),
                422,
                'PHONE_CODE_INVALID',
            );
            expectError(
                await t.http
                    .post(`${t.prefix}/me/phone/code`)
                    .set('Authorization', bearer)
                    .send({ phone: '375291234567' }),
                422,
                'PHONE_COUNTRY_NOT_SUPPORTED',
            );
        });
    });

    describe('POST /services/:id/clone', () => {
        it('copies the settings and options as a draft, without bookable slots and bookings', async () => {
            const organization = await fx.organization();
            const admin = await fx.admin([organization.id]);
            const bearer = await fx.bearer(admin);
            const bookable = fx.bookableOption(3);
            const payment = {
                id: randomUUID(),
                label: 'Pay online',
                service_type: 'service_payment' as const,
                enabled: true,
                slots: [
                    {
                        id: randomUUID(),
                        label: 'Card',
                        child_type: 'paycard' as const,
                        value: { link: 'https://pay.example.com', price: '10' },
                    },
                ],
            };
            const source = await fx.service(organization.id, {
                label: 'Passport',
                description: 'Passport consultation',
                tags: ['documents'],
                duration_minutes: 30,
                options: [bookable, payment],
            });
            const booked = await t.http
                .post(`${t.prefix}/services/${source.id}/bookings`)
                .set('Authorization', await fx.bearer(await fx.client()))
                .send({ option_id: bookable.id, slot_id: bookable.slot_id, time: '10:00' });
            expect(booked.status).toBe(201);

            const res = await t.http
                .post(`${t.prefix}/services/${source.id}/clone`)
                .set('Authorization', bearer);
            expect(res.status).toBe(201);
            const clone = res.body.data;
            expect(res.headers['location']).toBe(`/services/${clone.id}`);
            expect(clone.id).not.toBe(source.id);
            expect(clone).toMatchObject({
                organization_id: organization.id,
                label: 'Passport (copy)',
                slug: 'passport-copy',
                status: 'draft',
                enabled: false,
                published_at: null,
                description: 'Passport consultation',
                tags: ['documents'],
                duration_minutes: 30,
            });
            expect(clone.options).toHaveLength(2);
            expect(clone.options.map((option: { id: string }) => option.id)).not.toContain(bookable.id);
            expect(clone.options[0]).toMatchObject({
                label: 'Booking',
                service_type: 'service_apply',
                slots: [],
            });
            expect(clone.options[1].slots).toHaveLength(1);
            expect(clone.options[1].slots[0]).toMatchObject({
                label: 'Card',
                child_type: 'paycard',
                value: { link: 'https://pay.example.com', price: '10' },
            });
            expect(clone.options[1].slots[0].id).not.toBe(payment.slots[0]!.id);

            const cloneBookings = await t.http
                .get(`${t.prefix}/services/${clone.id}/bookings?status=all`)
                .set('Authorization', bearer);
            expect(cloneBookings.body.meta.total).toBe(0);

            const sourceAfter = await t.http
                .get(`${t.prefix}/services/${source.id}`)
                .set('Authorization', bearer);
            expect(sourceAfter.body.data.label).toBe('Passport');
            expect(sourceAfter.body.data.options[0].slots).toHaveLength(1);

            const history = await t.http
                .get(`${t.prefix}/services/${clone.id}/history`)
                .set('Authorization', bearer);
            expect(history.body.data[0].action).toBe('create');
        });

        it('takes a label and a slug, and checks access and existence', async () => {
            const organization = await fx.organization();
            const admin = await fx.admin([organization.id]);
            const bearer = await fx.bearer(admin);
            const source = await fx.service(organization.id, { label: 'Visa', slug: 'visa' });

            const named = await t.http
                .post(`${t.prefix}/services/${source.id}/clone`)
                .set('Authorization', bearer)
                .send({ label: 'Visa express', slug: 'visa-express' });
            expect(named.status).toBe(201);
            expect(named.body.data).toMatchObject({ label: 'Visa express', slug: 'visa-express' });

            expectError(
                await t.http
                    .post(`${t.prefix}/services/${source.id}/clone`)
                    .set('Authorization', bearer)
                    .send({ slug: 'visa' }),
                409,
                'SERVICE_SLUG_TAKEN',
            );
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${source.id}/clone`)
                    .set('Authorization', bearer)
                    .send({ label: '' }),
                400,
                'VALIDATION_ERROR',
            );

            const operator = await fx.user({ role: ROLES.OPERATOR, organization_ids: [organization.id] });
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${source.id}/clone`)
                    .set('Authorization', await fx.bearer(operator)),
                403,
                'FORBIDDEN',
            );
            const stranger = await fx.admin([(await fx.organization()).id]);
            expectError(
                await t.http
                    .post(`${t.prefix}/services/${source.id}/clone`)
                    .set('Authorization', await fx.bearer(stranger)),
                404,
                'SERVICE_NOT_FOUND',
            );

            const removed = await t.http
                .delete(`${t.prefix}/services/${source.id}`)
                .set('Authorization', bearer);
            expect(removed.status).toBe(204);
            expectError(
                await t.http.post(`${t.prefix}/services/${source.id}/clone`).set('Authorization', bearer),
                404,
                'SERVICE_NOT_FOUND',
            );
        });
    });
});
