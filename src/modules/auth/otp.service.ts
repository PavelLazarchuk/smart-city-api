import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';

import { AppConfig } from '../../common/config/app-config';
import { ApiError } from '../../common/http/api-error';
import { type ErrorCode } from '../../common/i18n/messages';
import { PasswordService } from './password.service';
import {
    LOGIN_SCOPE,
    type OtpScope,
    VerificationCodesRepository,
} from './store/verification-codes.repository';

@Injectable()
export class OtpService {
    constructor(
        private readonly codes: VerificationCodesRepository,
        private readonly passwords: PasswordService,
        private readonly config: AppConfig,
    ) {}

    generateCode(): string {
        const length = this.config.otp.length;
        const max = 10 ** length;

        return randomInt(0, max).toString().padStart(length, '0');
    }

    get ttlSeconds(): number {
        return this.config.otp.ttlSeconds;
    }

    async issue(phone: string, scope: OtpScope = LOGIN_SCOPE): Promise<string> {
        const code = this.generateCode();
        const expiresAt = new Date(Date.now() + this.config.otp.ttlSeconds * 1000);
        await this.codes.issue(phone, await this.passwords.hash(code), expiresAt, scope);

        return code;
    }

    /** Same cost as `issue`: the branch that ignores a request must not be measurably faster. */
    async burnEquivalentWork(): Promise<void> {
        await this.passwords.hash(this.generateCode());
    }

    async verify(phone: string, code: string, scope: OtpScope = LOGIN_SCOPE): Promise<void> {
        const failure = await this.check(phone, code, scope);

        if (failure) throw ApiError.unauthorized(failure);
    }

    async confirm(phone: string, code: string, scope: OtpScope): Promise<boolean> {
        return (await this.check(phone, code, scope)) === null;
    }

    /** The attempt is counted before the comparison, so parallel guesses cannot stretch the limit to `max + N`. */
    private async check(phone: string, code: string, scope: OtpScope): Promise<ErrorCode | null> {
        const record = await this.codes.findLatestActive(phone, scope);

        if (!record) return 'OTP_INVALID';

        if (record.expires_at.getTime() < Date.now()) return 'OTP_EXPIRED';

        const attempts = await this.codes.registerAttempt(record._id.toHexString());

        if (attempts === null || attempts > this.config.otp.maxAttempts) return 'OTP_ATTEMPTS_EXCEEDED';

        if (!(await this.passwords.verify(record.code_hash, code))) return 'OTP_INVALID';

        return (await this.codes.consume(record._id.toHexString())) ? null : 'OTP_INVALID';
    }
}
