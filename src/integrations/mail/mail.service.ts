import { Inject, Injectable } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import { PinoLogger } from 'nestjs-pino';

import { inSpan } from '../../common/tracing/spans';
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
            await inSpan(
                'mail send',
                {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'mail.recipients': message.to.length,
                        'mail.attachments': message.attachments?.length ?? 0,
                    },
                },
                () => this.provider.send(message),
            );
        } catch (error) {
            this.logger.error({ err: error, subject: message.subject }, 'mail delivery failed');
            throw error;
        }
    }
}
