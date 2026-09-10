import { Module } from '@nestjs/common';

import { AppConfig } from '../../common/config/app-config';
import { ConsoleMailProvider } from './console-mail.provider';
import { MAIL_PROVIDER } from './mail.provider';
import { MailService } from './mail.service';
import { SmtpMailProvider } from './smtp-mail.provider';

@Module({
    providers: [
        ConsoleMailProvider,
        SmtpMailProvider,
        {
            provide: MAIL_PROVIDER,
            inject: [AppConfig, ConsoleMailProvider, SmtpMailProvider],
            useFactory: (config: AppConfig, console: ConsoleMailProvider, smtp: SmtpMailProvider) =>
                config.mail.provider === 'smtp' ? smtp : console,
        },
        MailService,
    ],
    exports: [MailService],
})
export class MailModule {}
