export interface MailAttachment {
    filename: string;
    content: Buffer;
    content_type?: string;
}

export interface MailMessage {
    to: string[];
    subject: string;
    text: string;
    attachments?: MailAttachment[];
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export interface MailProvider {
    send(message: MailMessage): Promise<void>;
    check(): Promise<void>;
}
