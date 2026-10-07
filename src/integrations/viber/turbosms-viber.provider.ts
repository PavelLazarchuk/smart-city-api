import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../common/config/app-config';
import { VIBER_TIMEOUT_MS } from '../../common/config/constants';
import { type ViberMessage, type ViberProvider } from './viber.provider';

interface TurboSmsResult {
    response_code?: number;
    response_status?: string;
}

interface TurboSmsResponse extends TurboSmsResult {
    response_result?: TurboSmsResult[] | null;
}

const ACCEPTED = new Set([0, 800, 801, 802, 803]);

@Injectable()
export class TurboSmsViberProvider implements ViberProvider {
    readonly name = 'turbosms';

    constructor(private readonly config: AppConfig) {}

    async send({ phone, text, fallbackSms }: ViberMessage): Promise<void> {
        const { sender, turbosms } = this.config.viber;
        const response = await fetch(new URL('/message/send.json', turbosms.url), {
            method: 'POST',
            headers: {
                authorization: `Bearer ${turbosms.token ?? ''}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                recipients: [phone],
                viber: { sender, text },
                ...(fallbackSms === null ? {} : { sms: { sender: turbosms.smsSender, text: fallbackSms } }),
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(VIBER_TIMEOUT_MS),
        });

        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`TurboSMS HTTP ${response.status}`);
        }

        const result = (await response.json()) as TurboSmsResponse;
        const recipient = result.response_result?.[0];

        for (const outcome of [result, recipient]) {
            if (outcome?.response_code !== undefined && !ACCEPTED.has(outcome.response_code))
                throw new Error(`TurboSMS ${outcome.response_code} ${outcome.response_status ?? ''}`.trim());
        }
    }
}
