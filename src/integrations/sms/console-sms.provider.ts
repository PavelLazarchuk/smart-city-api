import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { type SmsProvider } from './sms.provider';

@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
    readonly name = 'console';

    constructor(
        private readonly logger: PinoLogger,
        private readonly config: AppConfig,
    ) {
        this.logger.setContext(ConsoleSmsProvider.name);
    }

    send(phone: string, text: string): Promise<void> {
        const body = this.config.isProduction ? '[redacted]' : text;
        this.logger.info({ phone, body }, 'sms (console provider)');

        return Promise.resolve();
    }
}
