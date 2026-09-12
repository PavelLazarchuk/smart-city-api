import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfig } from '../../common/config/app-config';
import { ConsoleSmsProvider } from '../../integrations/sms/console-sms.provider';
import { SmppSmsProvider } from '../../integrations/sms/smpp-sms.provider';
import { SMS_PROVIDER } from '../../integrations/sms/sms.provider';
import { SmsCounter, SmsCounterSchema } from './schemas/sms-counter.schema';
import { Sms, SmsSchema } from './schemas/sms.schema';
import { SmsBudgetService } from './sms-budget.service';
import { SmsRepository } from './sms.repository';
import { SmsService } from './sms.service';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Sms.name, schema: SmsSchema },
            { name: SmsCounter.name, schema: SmsCounterSchema },
        ]),
    ],
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
        SmsBudgetService,
        SmsService,
    ],
    exports: [SmsService, SmsBudgetService],
})
export class SmsModule {}
