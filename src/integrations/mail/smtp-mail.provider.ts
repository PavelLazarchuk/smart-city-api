import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { AppConfig } from '../../common/config/app-config';
import { type MailMessage, type MailProvider } from './mail.provider';

@Injectable()
export class SmtpMailProvider implements MailProvider {
    private readonly transporter: Transporter;

    constructor(private readonly config: AppConfig) {
        const { smtp } = config.mail;
        this.transporter = createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
            tls: { rejectUnauthorized: smtp.rejectUnauthorized },
        });
    }

    async check(): Promise<void> {
        await this.transporter.verify();
    }

    async send(message: MailMessage): Promise<void> {
        const { from } = this.config.mail;
        await this.transporter.sendMail({
            from: `${from.name} <${from.address}>`,
            to: message.to.join(', '),
            subject: message.subject,
            text: message.text,
            attachments: message.attachments?.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.content_type,
            })),
        });
    }
}
