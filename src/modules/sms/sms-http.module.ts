import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuthStoreModule } from '../auth/store/auth-store.module';
import { OtpService } from '../auth/otp.service';
import { SmsController } from './sms.controller';
import { SmsModule } from './sms.module';

/** The SMS admin endpoints need the OTP generator (test message) and therefore sit above AuthModule. */
@Module({
    imports: [SmsModule, AuthModule, AuthStoreModule],
    providers: [OtpService],
    controllers: [SmsController],
})
export class SmsHttpModule {}
