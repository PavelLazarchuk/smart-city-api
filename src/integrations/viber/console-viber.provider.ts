import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { type ViberMessage, type ViberProvider } from './viber.provider';

@Injectable()
export class ConsoleViberProvider implements ViberProvider {
    readonly name = 'console';

    constructor(
        private readonly logger: PinoLogger,
        private readonly config: AppConfig,
    ) {
        this.logger.setContext(ConsoleViberProvider.name);
    }

    send({ phone, text, fallbackSms }: ViberMessage): Promise<void> {
        const redacted = this.config.isProduction;
        this.logger.info(
            {
                phone,
                body: redacted ? '[redacted]' : text,
                fallback_sms: fallbackSms === null ? null : redacted ? '[redacted]' : fallbackSms,
            },
            'viber (console provider)',
        );

        return Promise.resolve();
    }
}
