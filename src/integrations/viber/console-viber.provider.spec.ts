import { type PinoLogger } from 'nestjs-pino';

import { type AppConfig } from '../../common/config/app-config';
import { ConsoleViberProvider } from './console-viber.provider';

function setup(isProduction: boolean) {
    const logger = { setContext: jest.fn(), info: jest.fn() };
    const provider = new ConsoleViberProvider(logger as unknown as PinoLogger, { isProduction } as AppConfig);

    return { provider, logger };
}

describe('ConsoleViberProvider', () => {
    it('logs the message and its fallback outside production', async () => {
        const { provider, logger } = setup(false);

        await provider.send({ phone: '49152', text: 'Hi', fallbackSms: 'Hi by SMS' });

        expect(provider.name).toBe('console');
        expect(logger.info).toHaveBeenCalledWith(
            { phone: '49152', body: 'Hi', fallback_sms: 'Hi by SMS' },
            'viber (console provider)',
        );
    });

    it('redacts both texts in production and keeps a missing fallback as null', async () => {
        const { provider, logger } = setup(true);

        await provider.send({ phone: '49152', text: 'Hi', fallbackSms: 'Hi by SMS' });
        await provider.send({ phone: '49152', text: 'Hi', fallbackSms: null });

        expect(logger.info.mock.calls[0]![0]).toEqual({
            phone: '49152',
            body: '[redacted]',
            fallback_sms: '[redacted]',
        });
        expect(logger.info.mock.calls[1]![0]).toEqual({
            phone: '49152',
            body: '[redacted]',
            fallback_sms: null,
        });
    });
});
