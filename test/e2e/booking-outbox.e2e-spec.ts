import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { OutboxService } from '../../src/common/outbox/outbox.service';
import { expectError, waitFor } from '../support/assertions';
import { dateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

interface Received {
    headers: IncomingMessage['headers'];
    body: string;
}

async function receiver(): Promise<{
    url: string;
    received: Received[];
    status: { code: number };
    close(): Promise<void>;
}> {
    const received: Received[] = [];
    const status = { code: 200 };
    const server: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            received.push({ headers: req.headers, body });
            res.statusCode = status.code;
            res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}/hook`,
        received,
        status,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

const uuid = (n: number) =>
    `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

describe('booking outbox and webhooks (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;
    let client: FixtureUser;
    let bearer: string;

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
        client = await fx.client({ name: 'Anna', phone: '4915291234567' });
        bearer = await fx.bearer(client);
    });

    const book = (serviceId: string, body: Record<string, unknown>, token = bearer) =>
        t.http.post(`${t.prefix}/services/${serviceId}/bookings`).set('Authorization', token).send(body);

    const serviceWith = (
        overrides: Record<string, unknown>,
        days = 2,
        time = '10:00',
        limit: number | null = 2,
    ) =>
        fx.service(organization.id, {
            options: [
                {
                    id: uuid(1),
                    label: 'x',
                    service_type: 'service_apply',
                    enabled: true,
                    slots: [
                        {
                            id: uuid(2),
                            label: 'd',
                            child_type: 'date_time',
                            value: {
                                date: dateOnly(days),
                                time: [
                                    { time, limit, booked_count: 0 },
                                    { time: '11:00', limit, booked_count: 0 },
                                ],
                            },
                        },
                        {
                            id: uuid(3),
                            label: 'a',
                            child_type: 'apply',
                            value: { limit: null, booked_count: 0 },
                        },
                    ],
                },
            ],
            ...overrides,
        });

    describe('outbox and webhooks', () => {
        it('delivers a signed booking.created event to the organization hook and retries a failing one', async () => {
            const hook = await receiver();
            try {
                const created = await t.http
                    .post(`${t.prefix}/webhooks`)
                    .set('Authorization', adminBearer)
                    .send({
                        organization_id: organization.id,
                        url: hook.url,
                        events: ['booking.created', 'booking.cancelled'],
                    });
                expect(created.status).toBe(201);
                expect(created.body.data.secret).toMatch(/^whsec_/);
                const secret = created.body.data.secret as string;
                const webhookId = created.body.data.id as string;
                expect(
                    (await t.http.get(`${t.prefix}/webhooks/${webhookId}`).set('Authorization', adminBearer))
                        .body.data.secret,
                ).toBeUndefined();
                expectError(
                    await t.http
                        .post(`${t.prefix}/webhooks`)
                        .set('Authorization', adminBearer)
                        .send({ url: hook.url, events: ['booking.created'] }),
                    403,
                );
                expectError(
                    await t.http
                        .post(`${t.prefix}/webhooks`)
                        .set('Authorization', adminBearer)
                        .send({
                            organization_id: organization.id,
                            url: 'ftp://x/y',
                            events: ['booking.created'],
                        }),
                    400,
                    'VALIDATION_ERROR',
                );

                const service = await serviceWith({
                    value: { heading_value: 'Therapist', subscribe: 'clinic@example.com' },
                });
                const booking = await book(service.id, {
                    option_id: uuid(1),
                    slot_id: uuid(2),
                    time: '10:00',
                });
                expect(booking.status).toBe(201);
                await waitFor(() => Promise.resolve(hook.received.length === 1));
                const [delivery] = hook.received;
                const body = JSON.parse(delivery!.body) as { type: string; data: Record<string, unknown> };
                expect(body.type).toBe('booking.created');
                expect(body.data).toMatchObject({
                    booking_id: booking.body.data.booking_id,
                    service_id: service.id,
                    status: 'confirmed',
                });
                expect(JSON.stringify(body)).not.toContain('4915291234567');
                expect(JSON.stringify(body)).not.toContain('clinic@example.com');
                const timestamp = delivery!.headers['x-webhook-timestamp'] as string;
                expect(delivery!.headers['x-webhook-signature']).toBe(
                    `sha256=${createHmac('sha256', secret).update(`${timestamp}.${delivery!.body}`).digest('hex')}`,
                );
                expect(delivery!.headers['x-webhook-event']).toBe('booking.created');

                // The hook records the request before it answers, so the row reaches
                // "delivered" only once the dispatcher has written the outcome back.
                const events = await waitFor(async () => {
                    const res = await t.http
                        .get(`${t.prefix}/outbox/events?type=booking.created`)
                        .set('Authorization', adminBearer);

                    return res.body.data.length === 1 && res.body.data[0].status === 'delivered' ? res : null;
                });
                expect(events!.body.data).toHaveLength(1);
                expect(events!.body.data[0]).toMatchObject({ status: 'delivered' });
                expect(
                    events!.body.data[0].deliveries.map((d: { target: string; status: string }) => [
                        d.target.split(':')[0],
                        d.status,
                    ]),
                ).toEqual([
                    ['handler', 'delivered'],
                    ['handler', 'delivered'],
                    ['webhook', 'delivered'],
                ]);

                hook.status.code = 500;
                await t.http
                    .delete(`${t.prefix}/bookings/${booking.body.data.booking_id}`)
                    .set('Authorization', bearer);
                await waitFor(() => Promise.resolve(hook.received.length === 2));
                await waitFor(
                    async () =>
                        (await fx
                            .collection('OutboxEvent')
                            .countDocuments({ type: 'booking.cancelled', attempts: 1 })) === 1,
                );
                const pending = await fx
                    .collection<{ status: string; next_attempt_at: Date; last_error: string }>('OutboxEvent')
                    .findOne({ type: 'booking.cancelled' })
                    .lean();
                expect(pending).toMatchObject({ status: 'pending' });
                expect(pending!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
                expect(pending!.last_error).toContain('HTTP 500');
                const hookRow = await t.http
                    .get(`${t.prefix}/webhooks/${webhookId}`)
                    .set('Authorization', adminBearer);
                expect(hookRow.body.data.consecutive_failures).toBe(1);

                hook.status.code = 204;
                // A dispatch that lands on a pass still draining in the background gets that
                // pass's summary, run against the real clock, so retry until ours does the work.
                const summary = await waitFor(async () => {
                    const pass = await t.app.get(OutboxService).dispatch(new Date(Date.now() + 10 * 60_000));

                    return pass.delivered === 1 ? pass : null;
                });
                // A concurrent rerun can fold its own claims into the summary, so only the
                // single delivery is fixed; the processed count is not.
                expect(summary!.delivered).toBe(1);
                expect(summary!.processed).toBeGreaterThanOrEqual(1);
                expect(hook.received).toHaveLength(3);

                const test = await t.http
                    .post(`${t.prefix}/webhooks/${webhookId}/test`)
                    .set('Authorization', adminBearer);
                expect(test.status).toBe(202);
                await waitFor(() => Promise.resolve(hook.received.length === 4));
                expect((JSON.parse(hook.received[3]!.body) as { type: string }).type).toBe('webhook.test');

                const rotated = await t.http
                    .post(`${t.prefix}/webhooks/${webhookId}/rotate-secret`)
                    .set('Authorization', adminBearer);
                expect(rotated.body.data.secret).not.toBe(secret);
                expect(
                    (
                        await t.http
                            .delete(`${t.prefix}/webhooks/${webhookId}`)
                            .set('Authorization', adminBearer)
                    ).status,
                ).toBe(204);
            } finally {
                await hook.close();
            }
        });
    });
});
