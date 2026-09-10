import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MongoThrottlerStorage } from '../mongo-throttler.storage';
import { PasswordService } from '../password.service';
import { PhonePolicy } from '../phone.policy';
import { RateLimit, RateLimitSchema } from '../schemas/rate-limit.schema';
import { Session, SessionSchema } from '../schemas/session.schema';
import { VerificationCode, VerificationCodeSchema } from '../schemas/verification-code.schema';
import { AuthStoreService } from './auth-store.service';
import { SessionsRepository } from './sessions.repository';
import { VerificationCodesRepository } from './verification-codes.repository';

/** Auth persistence and policies, with no dependency on the users module — keeps the module graph acyclic. */
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Session.name, schema: SessionSchema },
            { name: VerificationCode.name, schema: VerificationCodeSchema },
            { name: RateLimit.name, schema: RateLimitSchema },
        ]),
    ],
    providers: [
        SessionsRepository,
        VerificationCodesRepository,
        AuthStoreService,
        PasswordService,
        PhonePolicy,
        MongoThrottlerStorage,
    ],
    exports: [
        MongooseModule,
        SessionsRepository,
        VerificationCodesRepository,
        AuthStoreService,
        PasswordService,
        PhonePolicy,
        MongoThrottlerStorage,
    ],
})
export class AuthStoreModule {}
