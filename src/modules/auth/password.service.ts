import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import { AppConfig } from '../../common/config/app-config';
import { ApiError } from '../../common/http/api-error';

const PASSWORD_CLASSES = [
    { pattern: /[a-z]/, message: 'At least one lowercase latin letter' },
    { pattern: /[A-Z]/, message: 'At least one uppercase latin letter' },
    { pattern: /\d/, message: 'At least one digit' },
    { pattern: /[^A-Za-z0-9]/, message: 'At least one special character' },
] as const;

@Injectable()
export class PasswordService {
    private dummyHash?: Promise<string>;

    constructor(private readonly config: AppConfig) {}

    get loginMinLength(): number {
        return this.config.auth.loginMinLength;
    }

    hash(plain: string): Promise<string> {
        const { memoryCost, timeCost, parallelism } = this.config.auth.argon2;

        return argon2.hash(plain, { type: argon2.argon2id, memoryCost, timeCost, parallelism });
    }

    async verify(hash: string, plain: string): Promise<boolean> {
        try {
            return await argon2.verify(hash, plain);
        } catch {
            return false;
        }
    }

    /**
     * Spends one verification against a throwaway hash. Login calls it when there is no stored hash so
     * that an unknown account costs the same as a known one.
     */
    async verifyDummy(plain: string): Promise<void> {
        this.dummyHash ??= this.hash('constant-time-placeholder');
        await this.verify(await this.dummyHash, plain);
    }

    assertPolicy(password: string): void {
        const { passwordMinLength, passwordMaxLength } = this.config.auth;

        if (password.length < passwordMinLength)
            throw ApiError.unprocessable('PASSWORD_TOO_SHORT', [
                { path: 'password', message: `At least ${passwordMinLength} characters` },
            ]);

        if (password.length > passwordMaxLength)
            throw ApiError.unprocessable('PASSWORD_TOO_LONG', [
                { path: 'password', message: `At most ${passwordMaxLength} characters` },
            ]);

        const missing = PASSWORD_CLASSES.filter((entry) => !entry.pattern.test(password)).map((entry) => ({
            path: 'password',
            message: entry.message,
        }));

        if (missing.length > 0) throw ApiError.unprocessable('PASSWORD_TOO_WEAK', missing);
    }
}
