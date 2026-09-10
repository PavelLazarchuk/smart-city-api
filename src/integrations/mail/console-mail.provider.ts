import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { type MailMessage, type MailProvider } from './mail.provider';

@Injectable()
export class ConsoleMailProvider implements MailProvider {
    constructor(private readonly logger: PinoLogger) {
        this.logger.setContext(ConsoleMailProvider.name);
    }

    send(message: MailMessage): Promise<void> {
        this.logger.info(
            {
                to: message.to,
                subject: message.subject,
                attachments: (message.attachments ?? []).map((attachment) => attachment.filename),
            },
            'mail (console provider)',
        );

        return Promise.resolve();
    }
}
