import { Injectable } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { UsersService } from '../users/users.service';

const DELAY_STEP_MS = 100;
const DELAY_CAP_MS = 2000;

/**
 * Per-account failure budget: IP and phone throttling cannot see one account attacked from a thousand
 * addresses. The window is sliding — without the decay a wrong password per hour would lock a known
 * account out for good.
 */
@Injectable()
export class LoginAttemptsService {
    constructor(
        private readonly users: UsersService,
        private readonly config: AppConfig,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(LoginAttemptsService.name);
    }

    isLocked(user: { locked_until?: Date }, now = new Date()): boolean {
        return user.locked_until !== undefined && user.locked_until.getTime() > now.getTime();
    }

    async registerFailure(userId: string, now = new Date()): Promise<void> {
        const { maxFailedAttempts, lockoutSeconds, lockoutMaxSeconds, failedAttemptWindowSeconds } =
            this.config.auth;
        const windowStart = new Date(now.getTime() - failedAttemptWindowSeconds * 1000);
        const attempts = await this.users.registerFailedLogin(userId, windowStart, now);

        if (attempts === null) return;

        if (attempts >= maxFailedAttempts) {
            const overflow = attempts - maxFailedAttempts;
            const seconds = Math.min(lockoutSeconds * 2 ** overflow, lockoutMaxSeconds);
            await this.users.lockAccount(userId, new Date(now.getTime() + seconds * 1000));
            this.logger.warn({ user_id: userId, attempts, seconds }, 'account locked after failed logins');
        }

        await this.stall(attempts);
    }

    async registerSuccess(user: { id: string; failed_login_attempts?: number }): Promise<void> {
        if (!user.failed_login_attempts) return;

        await this.users.clearFailedLogins(user.id);
    }

    /** Same stall for a locked account, so a lock is not detectable by a faster answer. */
    stall(attempts: number): Promise<void> {
        return delay(Math.min(attempts * DELAY_STEP_MS, DELAY_CAP_MS));
    }
}
