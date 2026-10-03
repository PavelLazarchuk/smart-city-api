import { lookup } from 'node:dns/promises';

import { type AppConfig } from '../config/app-config';
import { type OutboxEventEntity } from './outbox.repository';
import { type WebhookWithSecret } from './webhooks.repository';
import { WebhookDeliveryService } from './webhook-delivery.service';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

const lookupMock = lookup as unknown as jest.Mock;

function service(outbox: { allowPrivateHosts: boolean }, isProduction = false): WebhookDeliveryService {
    return new WebhookDeliveryService({
        isProduction,
        outbox: { ...outbox, webhookTimeoutMs: 1000 },
    } as unknown as AppConfig);
}

const webhook = (url: string) => ({ url, secret: 'whsec_x' }) as unknown as WebhookWithSecret;
const event = {
    id: 'e1',
    type: 'booking.created',
    created_at: new Date('2026-10-03T10:00:00.000Z'),
    organization_id: null,
    payload: { a: 1 },
} as unknown as OutboxEventEntity;

describe('WebhookDeliveryService', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        lookupMock.mockReset();
    });

    it('builds the body from the event', () => {
        expect(service({ allowPrivateHosts: true }).body(event)).toEqual({
            id: 'e1',
            type: 'booking.created',
            created_at: '2026-10-03T10:00:00.000Z',
            organization_id: null,
            data: { a: 1 },
        });
    });

    it('signs the timestamp and the body with the secret', () => {
        const signature = service({ allowPrivateHosts: true }).sign('s', '1', '{}');

        expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(signature).not.toBe(service({ allowPrivateHosts: true }).sign('s', '2', '{}'));
    });

    it('requires https in production unless private hosts are allowed', () => {
        expect(service({ allowPrivateHosts: false }, true).urlProblem('http://example.com/h')).not.toBeNull();
        expect(service({ allowPrivateHosts: false }, true).urlProblem('https://example.com/h')).toBeNull();
        expect(service({ allowPrivateHosts: true }, true).urlProblem('http://127.0.0.1/h')).toBeNull();
    });

    describe('deliver', () => {
        it('refuses a url that fails validation', async () => {
            await expect(
                service({ allowPrivateHosts: false }).deliver(webhook('ftp://x/y'), event),
            ).rejects.toThrow('webhook url refused');
        });

        it('refuses a private literal address without resolving it', async () => {
            await expect(
                service({ allowPrivateHosts: false }).deliver(webhook('http://10.0.0.1/h'), event),
            ).rejects.toThrow('webhook url refused');
            expect(lookupMock).not.toHaveBeenCalled();
        });

        it('refuses a host that resolves to a private address', async () => {
            lookupMock.mockResolvedValue([{ address: '8.8.8.8' }, { address: '192.168.0.5' }]);
            const fetchSpy = jest.spyOn(global, 'fetch');

            await expect(
                service({ allowPrivateHosts: false }).deliver(webhook('https://example.com/h'), event),
            ).rejects.toThrow('resolves to a private address');
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('posts a signed body to a public host and fails on a non-2xx answer', async () => {
            lookupMock.mockResolvedValue([{ address: '8.8.8.8' }]);
            const fetchSpy = jest
                .spyOn(global, 'fetch')
                .mockResolvedValueOnce(new Response(null, { status: 204 }))
                .mockResolvedValueOnce(new Response(null, { status: 500 }));
            const delivery = service({ allowPrivateHosts: false });

            await expect(delivery.deliver(webhook('https://example.com/h'), event)).resolves.toBeUndefined();

            const [, init] = fetchSpy.mock.calls[0]!;
            const headers = init!.headers as Record<string, string>;

            expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
            expect(headers['x-webhook-event']).toBe('booking.created');
            expect(headers['x-webhook-id']).toBe('e1');
            expect(headers['x-webhook-signature']).toBe(
                delivery.sign('whsec_x', headers['x-webhook-timestamp']!, init!.body as string),
            );

            await expect(delivery.deliver(webhook('https://example.com/h'), event)).rejects.toThrow(
                'HTTP 500',
            );
        });

        it('treats a failed lookup as no addresses and skips the lookup when private hosts are allowed', async () => {
            lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
            jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

            await expect(
                service({ allowPrivateHosts: false }).deliver(webhook('https://example.com/h'), event),
            ).resolves.toBeUndefined();

            lookupMock.mockClear();
            await service({ allowPrivateHosts: true }).deliver(webhook('http://127.0.0.1/h'), event);
            expect(lookupMock).not.toHaveBeenCalled();
        });
    });
});
