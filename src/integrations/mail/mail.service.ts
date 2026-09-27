import { Inject, Injectable } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import { PinoLogger } from 'nestjs-pino';

import { texts } from '../../common/i18n/messages';
import { inSpan } from '../../common/tracing/spans';
import { MAIL_PROVIDER, type MailAttachment, type MailMessage, type MailProvider } from './mail.provider';

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

    sendBookingReminder(
        to: string,
        data: { service: string; date?: string; time?: string; phone: string },
        calendar?: MailAttachment | null,
    ): Promise<void> {
        return this.send({
            to: [to],
            subject: texts.mail.reminderSubject,
            text: texts.mail.reminderBody({ ...data, calendar: Boolean(calendar) }),
            ...(calendar ? { attachments: [calendar] } : {}),
        });
    }

    sendCallbackDue(
        to: string,
        data: {
            service: string;
            date?: string;
            time?: string;
            end_time?: string;
            phone: string;
            name: string;
        },
    ): Promise<void> {
        return this.send({
            to: [to],
            subject: texts.mail.callbackSubject,
            text: texts.mail.callbackBody(data),
        });
    }

    sendWaitlistNotification(
        to: string,
        data: { service: string; date?: string; time?: string; phone: string },
    ): Promise<void> {
        return this.send({
            to: [to],
            subject: texts.mail.waitlistSubject,
            text: texts.mail.waitlistBody(data),
        });
    }

    sendBookingCancellation(
        to: string,
        data: { service: string; date?: string; time?: string; phone: string; reason?: string },
    ): Promise<void> {
        return this.send({
            to: [to],
            subject: texts.mail.cancelledSubject,
            text: texts.mail.cancelledBody(data),
        });
    }

    sendBookingMoved(
        to: string,
        data: {
            service: string;
            date?: string;
            time?: string;
            previous_date?: string;
            previous_time?: string;
            phone: string;
            reason?: string;
        },
    ): Promise<void> {
        return this.send({
            to: [to],
            subject: texts.mail.movedSubject,
            text: texts.mail.movedBody(data),
        });
    }
}
