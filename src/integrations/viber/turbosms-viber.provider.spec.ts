import { type AppConfig } from '../../common/config/app-config';
import { TurboSmsViberProvider } from './turbosms-viber.provider';

const config = {
    viber: {
        provider: 'turbosms',
        sender: 'CityViber',
        turbosms: { url: 'https://api.turbosms.example', token: 'secret', smsSender: 'CitySms' },
    },
} as unknown as AppConfig;

function respond(status: number, body: unknown): jest.SpyInstance {
    return jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
            new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
        );
}

describe('TurboSmsViberProvider', () => {
    afterEach(() => jest.restoreAllMocks());

    it('posts a hybrid message with the SMS fallback', async () => {
        const fetch = respond(200, {
            response_code: 800,
            response_status: 'SUCCESS_MESSAGE_ACCEPTED',
            response_result: [{ phone: '380501234567', response_code: 0, response_status: 'OK' }],
        });

        await new TurboSmsViberProvider(config).send({
            phone: '380501234567',
            text: 'Viber body',
            fallbackSms: 'SMS body',
        });

        const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
        expect(url.toString()).toBe('https://api.turbosms.example/message/send.json');
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret');
        expect(JSON.parse(init.body as string)).toEqual({
            recipients: ['380501234567'],
            viber: { sender: 'CityViber', text: 'Viber body' },
            sms: { sender: 'CitySms', text: 'SMS body' },
        });
    });

    it('sends Viber only when there is no fallback', async () => {
        const fetch = respond(200, { response_code: 0, response_status: 'OK' });

        await new TurboSmsViberProvider(config).send({ phone: '380501234567', text: 'x', fallbackSms: null });

        expect(JSON.parse((fetch.mock.calls[0] as [URL, RequestInit])[1].body as string)).not.toHaveProperty(
            'sms',
        );
    });

    it('fails on an HTTP error and on a refused recipient', async () => {
        const provider = new TurboSmsViberProvider(config);
        const message = { phone: '380501234567', text: 'x', fallbackSms: null };

        respond(503, {});
        await expect(provider.send(message)).rejects.toThrow('TurboSMS HTTP 503');

        respond(200, {
            response_code: 800,
            response_result: [{ response_code: 406, response_status: 'NOT_ALLOWED_RECIPIENT_COUNTRY' }],
        });
        await expect(provider.send(message)).rejects.toThrow('TurboSMS 406 NOT_ALLOWED_RECIPIENT_COUNTRY');
    });
});
