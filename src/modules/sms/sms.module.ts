import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfig } from '../../common/config/app-config';
import { ConsoleSmsProvider } from '../../integrations/sms/console-sms.provider';
import { SmppSmsProvider } from '../../integrations/sms/smpp-sms.provider';
import { SMS_PROVIDER } from '../../integrations/sms/sms.provider';
import { Sms, SmsSchema } from './schemas/sms.schema';
import { SmsRepository } from './sms.repository';
import { SmsService } from './sms.service';

@Module({
    imports: [MongooseModule.forFeature([{ name: Sms.name, schema: SmsSchema }])],
    providers: [
        ConsoleSmsProvider,
        SmppSmsProvider,
        {
            provide: SMS_PROVIDER,
            inject: [AppConfig, ConsoleSmsProvider, SmppSmsProvider],
            useFactory: (config: AppConfig, console: ConsoleSmsProvider, smpp: SmppSmsProvider) =>
                config.sms.provider === 'smpp' ? smpp : console,
        },
        SmsRepository,
        SmsService,
    ],
    exports: [SmsService],
})
export class SmsModule {}
