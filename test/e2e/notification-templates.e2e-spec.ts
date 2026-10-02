import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { type MailMessage } from '../../src/integrations/mail/mail.provider';
import { ConsoleSmsProvider } from '../../src/integrations/sms/console-sms.provider';
import { expectError, waitFor } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('notification templates (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: string;

    const path = (key = '', organizationId = organization.id) =>
        `${t.prefix}/organizations/${organizationId}/notification-templates${key ? `/${key}` : ''}`;

    const put = (key: string, body: object, bearer = admin) =>
        t.http.put(path(key)).set('Authorization', bearer).send(body);

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization();
        admin = await fx.bearer(await fx.admin([organization.id]));
    });

    it('lists every notification with the built-in text until the organization sets its own', async () => {
        const res = await t.http.get(path()).set('Authorization', admin);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(12);
        const reminder = res.body.data.find((row: { key: string }) => row.key === 'booking_reminder_sms');
        expect(reminder).toMatchObject({
            event: 'booking.reminder',
            channel: 'sms',
            custom: false,
            subject: null,
            default_subject: null,
            updated_at: null,
            updated_by: null,
        });
        expect(reminder.body).toBe(reminder.default_body);
        expect(reminder.variables).toEqual(['service', 'date', 'time', 'end_time']);
    });

    it('saves, reads back and resets a template', async () => {
        const saved = await put('booking_cancelled_mail', {
            subject: '  Clinic No. 3: {{service}} cancelled  ',
            body: 'Dear client,\r\n{{#reason}}\r\n{{reason}}\r\n{{/reason}}\r\nSee you.',
        });

        expect(saved.status).toBe(200);
        expect(saved.body.data).toMatchObject({
            key: 'booking_cancelled_mail',
            custom: true,
            subject: 'Clinic No. 3: {{service}} cancelled',
            body: 'Dear client,\n{{#reason}}\n{{reason}}\n{{/reason}}\nSee you.',
            default_subject: 'Smart City: booking cancelled',
        });
        expect(saved.body.data.updated_by).toEqual(expect.any(String));

        const read = await t.http.get(path('booking_cancelled_mail')).set('Authorization', admin);
        expect(read.body.data).toMatchObject({
            custom: true,
            subject: 'Clinic No. 3: {{service}} cancelled',
        });

        expect((await t.http.delete(path('booking_cancelled_mail')).set('Authorization', admin)).status).toBe(
            204,
        );
        expect((await t.http.delete(path('booking_cancelled_mail')).set('Authorization', admin)).status).toBe(
            204,
        );
        const reset = await t.http.get(path('booking_cancelled_mail')).set('Authorization', admin);
        expect(reset.body.data).toMatchObject({ custom: false, subject: 'Smart City: booking cancelled' });
    });

    it('refuses templates that would not render', async () => {
        const unknown = await put('booking_reminder_sms', { body: 'Hi {{password}}' });
        expectError(unknown, 400, 'VALIDATION_ERROR');
        expect(unknown.body.error.details[0]).toMatchObject({
            path: 'body',
            message: 'Unknown variable "password"',
            variables: ['service', 'date', 'time', 'end_time'],
        });

        expectError(await put('booking_reminder_sms', { body: '{{#date}}x' }), 400, 'VALIDATION_ERROR');
        expectError(await put('booking_reminder_sms', { body: 'x', subject: 'y' }), 400, 'VALIDATION_ERROR');
        expectError(await put('booking_reminder_sms', { body: 'x'.repeat(641) }), 400, 'VALIDATION_ERROR');
        expectError(await put('booking_reminder_mail', { body: 'x' }), 400, 'VALIDATION_ERROR');
        expectError(
            await put('booking_reminder_mail', { subject: 'a\nb', body: 'x' }),
            400,
            'VALIDATION_ERROR',
        );
        expectError(
            await put('booking_reminder_mail', { subject: 'a', body: '   ' }),
            400,
            'VALIDATION_ERROR',
        );
        expectError(await put('otp_sms', { body: 'x' }), 404, 'NOTIFICATION_TEMPLATE_NOT_FOUND');
        expectError(
            await t.http.get(path('otp_sms')).set('Authorization', admin),
            404,
            'NOTIFICATION_TEMPLATE_NOT_FOUND',
        );
    });

    it('previews the stored template or a draft with sample data', async () => {
        const preview = (body: object) =>
            t.http
                .post(path('booking_moved_sms') + '/preview')
                .set('Authorization', admin)
                .send(body);

        const builtIn = await preview({});
        expect(builtIn.status).toBe(200);
        expect(builtIn.body.data).toEqual({
            subject: null,
            body: 'Passport consultation was moved to 2026-10-15, 10:00. The specialist is on sick leave.',
        });

        const draft = await preview({ body: 'Moved from {{previous_date}} to {{date}}.' });
        expect(draft.body.data.body).toBe('Moved from 2026-10-14 to 2026-10-15.');

        expectError(await preview({ body: '{{nope}}' }), 400, 'VALIDATION_ERROR');
    });

    it('sends the organization template and falls back to the built-in text elsewhere or when it renders empty', async () => {
        const sms = jest.spyOn(t.app.get(ConsoleSmsProvider), 'send').mockResolvedValue(undefined);
        const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);

        try {
            const other = await fx.organization();
            const otherAdmin = await fx.bearer(await fx.admin([other.id]));
            expect(
                (
                    await t.http
                        .put(path('booking_suspended_sms', other.id))
                        .set('Authorization', otherAdmin)
                        .send({ body: '{{until}}' })
                ).status,
            ).toBe(200);
            expect(
                (
                    await put('booking_suspended_sms', {
                        body: 'Clinic No. 3: {{service}} closed for you{{#until}} till {{until}}{{/until}}. {{reason}}',
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await put('booking_suspended_mail', {
                        subject: 'Clinic No. 3: {{service}}',
                        body: 'Closed: {{reason}}',
                    })
                ).status,
            ).toBe(200);

            const ours = (
                await fx.service(organization.id, {
                    options: [fx.bookableOption(5)],
                    value: { heading_value: 'Dentist' },
                })
            ).id;
            const theirs = (
                await fx.service(other.id, {
                    options: [fx.bookableOption(5)],
                    value: { heading_value: 'Therapist' },
                })
            ).id;
            const bySms = await fx.client();
            const byMail = await fx.client({ email: 'anna@example.com' });
            const suspend = (serviceId: string, userId: string, bearer: string) =>
                t.http
                    .post(`${t.prefix}/suspensions`)
                    .set('Authorization', bearer)
                    .send({ service_id: serviceId, user_id: userId, reason: 'Too many no-shows.' });

            expect((await suspend(ours, bySms.id, admin)).status).toBe(201);
            expect((await suspend(theirs, bySms.id, otherAdmin)).status).toBe(201);
            expect((await suspend(ours, byMail.id, admin)).status).toBe(201);
            await waitFor(
                async () =>
                    (await fx
                        .collection('OutboxEvent')
                        .countDocuments({ type: 'booking.suspended', status: 'delivered' })) === 3,
            );

            const texts = sms.mock.calls.map(([, text]) => text).sort();
            expect(texts).toEqual([
                'Booking Therapist is suspended. Too many no-shows.',
                'Clinic No. 3: Dentist closed for you. Too many no-shows.',
            ]);
            expect(mail.mock.calls).toHaveLength(1);
            const message: MailMessage = mail.mock.calls[0]![0];
            expect(message).toMatchObject({
                to: ['anna@example.com'],
                subject: 'Clinic No. 3: Dentist',
                text: 'Closed: Too many no-shows.',
            });
        } finally {
            sms.mockRestore();
            mail.mockRestore();
        }
    });

    it('keeps other organizations and operators out', async () => {
        const foreign = await fx.bearer(await fx.admin([(await fx.organization()).id]));
        const operator = await fx.bearer(
            await fx.user({ role: 'operator', organization_ids: [organization.id] }),
        );
        const client = await fx.bearer(await fx.client());
        const superAdmin = await fx.bearer(await fx.superAdmin());

        expectError(await t.http.get(path()).set('Authorization', foreign), 404, 'ORGANIZATION_NOT_FOUND');
        expectError(await put('booking_reminder_sms', { body: 'x' }, foreign), 404, 'ORGANIZATION_NOT_FOUND');
        expectError(await t.http.get(path()).set('Authorization', operator), 403, 'FORBIDDEN');
        expectError(await t.http.get(path()).set('Authorization', client), 403, 'FORBIDDEN');
        expectError(await t.http.get(path()), 401, 'UNAUTHENTICATED');
        expect((await put('booking_reminder_sms', { body: 'x' }, superAdmin)).status).toBe(200);
        expectError(
            await t.http.get(path('', '64b000000000000000000000')).set('Authorization', superAdmin),
            404,
            'ORGANIZATION_NOT_FOUND',
        );
    });

    it('removes the templates with the organization', async () => {
        expect((await put('booking_reminder_sms', { body: 'x' })).status).toBe(200);
        const superAdmin = await fx.bearer(await fx.superAdmin());

        expect(
            (
                await t.http
                    .delete(`${t.prefix}/organizations/${organization.id}`)
                    .set('Authorization', superAdmin)
            ).status,
        ).toBe(204);
        expect(await fx.collection('NotificationTemplate').countDocuments({})).toBe(0);
    });
});
