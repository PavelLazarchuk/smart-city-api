import { type PinoLogger } from 'nestjs-pino';

import { ApiError } from '../../common/http/api-error';
import { type MetricsService } from '../../common/metrics/metrics.service';
import { type PaginationService } from '../../common/pagination/pagination.service';
import { type SettingsService } from '../../common/settings/settings.service';
import { type ViberProvider } from '../../integrations/viber/viber.provider';
import { type SmsBudgetService } from './sms-budget.service';
import { type SmsRepository } from './sms.repository';
import { SmsService } from './sms.service';

interface Setup {
    viber?: ViberProvider | null;
    enabled?: boolean;
    fallback?: boolean;
    budget?: boolean;
}

function setup({ viber, enabled = true, fallback = true, budget = true }: Setup = {}) {
    const smsProvider = { name: 'smpp', send: jest.fn().mockResolvedValue(undefined) };
    const viberProvider =
        viber === undefined ? { name: 'turbosms', send: jest.fn().mockResolvedValue(undefined) } : viber;
    const rows = { create: jest.fn().mockResolvedValue(undefined) };
    const consume = jest.fn().mockResolvedValue({ allowed: budget });
    const settings = {
        get: jest.fn((key: string) => (key === 'viber.enabled' ? enabled : fallback)),
    };
    const service = new SmsService(
        smsProvider,
        viberProvider,
        settings as unknown as SettingsService,
        rows as unknown as SmsRepository,
        { consume } as unknown as SmsBudgetService,
        {} as PaginationService,
        { countSms: jest.fn() } as unknown as MetricsService,
        { setContext: jest.fn(), error: jest.fn() } as unknown as PinoLogger,
    );
    const render = jest.fn((channel: string) => Promise.resolve(`${channel} text`));

    return { service, smsProvider, viberProvider, rows, consume, render };
}

describe('SmsService.notify', () => {
    it('sends an SMS while Viber is off', async () => {
        const { service, smsProvider, rows, render } = setup({ enabled: false });

        await expect(service.notify('380501234567', 'reminder', render)).resolves.toBe('sent');
        expect(smsProvider.send).toHaveBeenCalledWith('380501234567', 'sms text');
        expect(render).toHaveBeenCalledTimes(1);
        expect(rows.create).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'sms', provider: 'smpp' }),
        );
    });

    it('sends an SMS when no Viber provider is configured', async () => {
        const { service, smsProvider } = setup({ viber: null });

        await service.notify('380501234567', 'reminder', jest.fn().mockResolvedValue('x'));
        expect(smsProvider.send).toHaveBeenCalled();
    });

    it('sends Viber with the SMS text as fallback and charges the SMS budget', async () => {
        const { service, smsProvider, viberProvider, rows, consume, render } = setup();

        await expect(service.notify('380501234567', 'waitlist', render)).resolves.toBe('sent');
        expect(consume).toHaveBeenCalledTimes(1);
        expect(smsProvider.send).not.toHaveBeenCalled();
        expect(viberProvider!.send).toHaveBeenCalledWith({
            phone: '380501234567',
            text: 'viber text',
            fallbackSms: 'sms text',
        });
        expect(rows.create).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'viber_sms', provider: 'turbosms', status: 'sent' }),
        );
    });

    it('drops the fallback when it is off or the SMS budget is spent', async () => {
        for (const options of [{ fallback: false }, { budget: false }]) {
            const { service, viberProvider, rows } = setup(options);

            await service.notify('380501234567', 'reminder', jest.fn().mockResolvedValue('text'));
            expect(viberProvider!.send).toHaveBeenCalledWith(expect.objectContaining({ fallbackSms: null }));
            expect(rows.create).toHaveBeenCalledWith(expect.objectContaining({ channel: 'viber' }));
        }
    });

    it('records a failed Viber delivery and throws so the outbox retries', async () => {
        const viber = { name: 'turbosms', send: jest.fn().mockRejectedValue(new Error('down')) };
        const { service, rows, render } = setup({ viber });

        await expect(service.notify('380501234567', 'reminder', render)).rejects.toMatchObject({
            code: 'VIBER_DELIVERY_FAILED',
        });
        expect(rows.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });

    it('refuses a direct Viber send without a provider', async () => {
        const { service } = setup({ viber: null });

        await expect(service.sendViber('380501234567', 'x', null, 'test')).rejects.toBeInstanceOf(ApiError);
    });
});
