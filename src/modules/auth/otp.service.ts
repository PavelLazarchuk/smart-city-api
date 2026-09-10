import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';

import { AppConfig } from '../../common/config/app-config';
import { ApiError } from '../../common/http/api-error';
import { PasswordService } from './password.service';
import { VerificationCodesRepository } from './store/verification-codes.repository';

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

    async issue(phone: string): Promise<string> {
        const code = this.generateCode();
        const expiresAt = new Date(Date.now() + this.config.otp.ttlSeconds * 1000);
        await this.codes.issue(phone, await this.passwords.hash(code), expiresAt);

        return code;
    }

    /**
     * Same cost as `issue` without storing or sending anything: the branch that ignores a request must
     * not be measurably faster than the one that answers it.
     */
    async burnEquivalentWork(): Promise<void> {
        await this.passwords.hash(this.generateCode());
    }

    /**
     * The attempt is counted before the comparison, atomically, so parallel guesses cannot share one
     * budget slot and stretch the limit to `max + N`.
     */
    async verify(phone: string, code: string): Promise<void> {
        const record = await this.codes.findLatestActive(phone);

        if (!record) throw ApiError.unauthorized('OTP_INVALID');

        if (record.expires_at.getTime() < Date.now()) throw ApiError.unauthorized('OTP_EXPIRED');

        const attempts = await this.codes.registerAttempt(record._id.toHexString());

        if (attempts === null || attempts > this.config.otp.maxAttempts)
            throw ApiError.unauthorized('OTP_ATTEMPTS_EXCEEDED');

        const matches = await this.passwords.verify(record.code_hash, code);

        if (!matches) throw ApiError.unauthorized('OTP_INVALID');

        const consumed = await this.codes.consume(record._id.toHexString());

        if (!consumed) throw ApiError.unauthorized('OTP_INVALID');
    }
}
