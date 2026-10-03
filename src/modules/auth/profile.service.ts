import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { SmsService } from '../sms/sms.service';
import { type UserEntity } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { type UpdateProfileInput } from './dto/auth.schemas';
import { OtpService } from './otp.service';
import { PhonePolicy } from './phone.policy';
import { AuthStoreService } from './store/auth-store.service';
import { type OtpScope } from './store/verification-codes.repository';

function phoneChangeScope(user: AuthUser): OtpScope {
    return { purpose: 'phone_change', user_id: user.id };
}

@Injectable()
export class ProfileService {
    constructor(
        private readonly users: UsersService,
        private readonly otp: OtpService,
        private readonly sms: SmsService,
        private readonly phonePolicy: PhonePolicy,
        private readonly authStore: AuthStoreService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(ProfileService.name);
    }

    async requestPhoneCode(user: AuthUser, phone: string): Promise<{ phone: string; expires_in: number }> {
        this.phonePolicy.assertSupported(phone);

        const response = { phone, expires_in: this.otp.ttlSeconds };
        const owner = await this.users.findByPhone(phone);

        if (owner) {
            await this.otp.burnEquivalentWork();

            return response;
        }

        const code = await this.otp.issue(phone, phoneChangeScope(user));

        try {
            await this.sms.send(phone, texts.sms.otp(code), 'verification');
        } catch (error) {
            this.logger.error({ err: error }, 'phone change sms delivery failed');
        }

        return response;
    }

    async update(user: AuthUser, input: UpdateProfileInput): Promise<UserEntity> {
        const current = await this.users.getById(user.id);
        const phone = input.phone !== undefined && input.phone !== current.phone ? input.phone : undefined;

        if (phone !== undefined) {
            this.phonePolicy.assertSupported(phone);

            if (!input.code) throw ApiError.unprocessable('PHONE_CODE_REQUIRED');

            if (!(await this.otp.confirm(phone, input.code, phoneChangeScope(user))))
                throw ApiError.unprocessable('PHONE_CODE_INVALID');
        }

        const updated = await this.users.updateSelf(user.id, { name: input.name, email: input.email, phone });

        if (phone !== undefined) {
            await this.authStore.revokeAllSessions(user.id, undefined, user.sid);

            if (current.phone) await this.authStore.deleteCodesForPhone(current.phone);
        }

        return updated;
    }
}
