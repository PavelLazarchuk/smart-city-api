import { randomUUID } from 'node:crypto';

import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { waitFor } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('slot closures and moves by e-mail (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let bearer: string;
    let mail: jest.SpyInstance;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        jest.restoreAllMocks();
        mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
        organization = await fx.organization();
        bearer = await fx.bearer(await fx.admin([organization.id]));
    });

    const setup = async () => {
        const slotId = randomUUID();
        const optionId = randomUUID();
        const service = await fx.service(organization.id, {
            value: { heading_value: 'Dentist' },
            options: [
                {
                    id: optionId,
                    label: 'Booking',
                    service_type: 'service_apply',
                    enabled: true,
                    slots: [
                        {
                            id: slotId,
                            label: 'Day',
                            child_type: 'date_time',
                            value: {
                                date: dateOnly(1),
                                time: [
                                    { time: '10:00', limit: 1, booked_count: 0 },
                                    { time: '11:00', limit: 1, booked_count: 0 },
                                ],
                            },
                        },
                    ],
                },
            ],
        });

        return { service: service.id, option: optionId, slot: slotId };
    };

    const book = async (
        ids: { service: string; option: string; slot: string },
        client: FixtureUser,
        time: string,
    ) =>
        t.http
            .post(`${t.prefix}/services/${ids.service}/bookings`)
            .set('Authorization', await fx.bearer(client))
            .send({ option_id: ids.option, slot_id: ids.slot, time });

    const delivered = () =>
        waitFor(
            async () =>
                (await fx.collection('OutboxEvent').countDocuments({ status: { $ne: 'delivered' } })) === 0,
        );

    const mailsTo = (address: string) =>
        mail.mock.calls.filter(([message]) => (message as { to: string[] }).to.includes(address));

    it('writes to a client with e-mail instead of texting when the slot is closed', async () => {
        const ids = await setup();
        const withMail = await fx.client({ email: 'anna@example.com' });
        const withPhone = await fx.client();
        await book(ids, withMail, '10:00');
        await book(ids, withPhone, '11:00');
        mail.mockClear();

        const closed = await t.http
            .post(`${t.prefix}/services/${ids.service}/options/${ids.option}/slots/${ids.slot}/cancel`)
            .set('Authorization', bearer)
            .send({ reason: 'Power cut' });
        expect(closed.status).toBe(200);
        expect(closed.body.data).toMatchObject({ cancelled: 2, notifications_queued: 2, removed: false });
        await delivered();

        expect(mailsTo('anna@example.com')).toHaveLength(1);
        expect(await fx.collection('Sms').countDocuments({ purpose: 'cancellation' })).toBe(1);
        expect(
            await fx.collection('Sms').countDocuments({ phone: withMail.phone, purpose: 'cancellation' }),
        ).toBe(0);
    });

    it('writes to a client with e-mail about a moved day and texts the others', async () => {
        const ids = await setup();
        const withMail = await fx.client({ email: 'bob@example.com' });
        const withPhone = await fx.client();
        await book(ids, withMail, '10:00');
        await book(ids, withPhone, '11:00');
        mail.mockClear();

        const moved = await t.http
            .post(`${t.prefix}/services/${ids.service}/options/${ids.option}/slots/${ids.slot}/move`)
            .set('Authorization', bearer)
            .send({ date: dateOnly(2), shift_minutes: -60 });
        expect(moved.status).toBe(200);
        expect(moved.body.data).toMatchObject({ moved: 2, date: dateOnly(2) });
        await delivered();

        expect(mailsTo('bob@example.com')).toHaveLength(1);
        expect(
            await fx.collection('Sms').countDocuments({ purpose: 'reschedule', phone: withPhone.phone }),
        ).toBe(1);
        expect(
            await fx.collection('Sms').countDocuments({ purpose: 'reschedule', phone: withMail.phone }),
        ).toBe(0);

        const times = (await fx.storedSlot(ids.service, ids.slot)).value.time!.map((entry) => entry.time);
        expect(times).toEqual(['09:00', '10:00']);
    });

    it('stays silent when the clients are not to be told', async () => {
        const ids = await setup();
        await book(ids, await fx.client({ email: 'quiet@example.com' }), '10:00');
        mail.mockClear();

        const closed = await t.http
            .post(`${t.prefix}/services/${ids.service}/options/${ids.option}/slots/${ids.slot}/cancel`)
            .set('Authorization', bearer)
            .send({ notify: false });
        expect(closed.body.data).toMatchObject({ cancelled: 1, notifications_queued: 0 });
        await delivered();

        expect(mailsTo('quiet@example.com')).toHaveLength(0);
        expect(await fx.collection('Sms').countDocuments({ purpose: 'cancellation' })).toBe(0);
    });
});
