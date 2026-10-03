import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptsService } from './login-attempts.service';
import { OtpService } from './otp.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { AuthStoreModule } from './store/auth-store.module';
import { TokenService } from './token.service';

@Module({
    imports: [AuthStoreModule, UsersModule, SmsModule, JwtModule.register({})],
    controllers: [AuthController, ProfileController],
    providers: [AuthService, TokenService, OtpService, LoginAttemptsService, ProfileService],
    exports: [AuthService, TokenService],
})
export class AuthModule {}
