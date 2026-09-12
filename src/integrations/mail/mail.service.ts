import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { texts } from '../../common/i18n/messages';
import { MAIL_PROVIDER, type MailMessage, type MailProvider } from './mail.provider';

@Injectable()
export class MailService {
    constructor(
        @Inject(MAIL_PROVIDER) private readonly provider: MailProvider,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(MailService.name);
    }

    check(): Promise<void> {
        return this.provider.check();
    }

    async send(message: MailMessage): Promise<void> {
        try {
            await this.provider.send(message);
        } catch (error) {
            this.logger.error({ err: error, subject: message.subject }, 'mail delivery failed');
            throw error;
        }
    }

    sendBookingNotification(
        to: string,
        data: { service: string; date?: string; time?: string; phone: string; name: string },
    ): Promise<void> {
        return this.send({
            to: [to],
            subject: texts.mail.bookingSubject,
            text: texts.mail.bookingBody(data),
        });
    }
}
