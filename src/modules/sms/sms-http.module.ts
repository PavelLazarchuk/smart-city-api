import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuthStoreModule } from '../auth/store/auth-store.module';
import { OtpService } from '../auth/otp.service';
import { SmsController } from './sms.controller';
import { SmsModule } from './sms.module';

@Module({
    imports: [SmsModule, AuthModule, AuthStoreModule],
    providers: [OtpService],
    controllers: [SmsController],
})
export class SmsHttpModule {}
