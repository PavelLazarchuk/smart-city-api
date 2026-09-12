import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { type Role, ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { type LoginMethod } from '../../common/config/env.schema';
import { SmsService } from '../sms/sms.service';
import { type UserEntity } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import {
    type LoginInput,
    type OtpVerifyInput,
    type RegisterInput,
    type TokenPairResponse,
} from './dto/auth.schemas';
import { LoginAttemptsService } from './login-attempts.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { PhonePolicy } from './phone.policy';
import { SessionsRepository } from './store/sessions.repository';
import { TokenService } from './token.service';

export interface ClientInfo {
    user_agent?: string;
    ip?: string;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly users: UsersService,
        private readonly sessions: SessionsRepository,
        private readonly tokens: TokenService,
        private readonly passwords: PasswordService,
        private readonly attempts: LoginAttemptsService,
        private readonly otp: OtpService,
        private readonly sms: SmsService,
        private readonly phonePolicy: PhonePolicy,
        private readonly config: AppConfig,
        private readonly tx: TransactionRunner,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(AuthService.name);
    }

    /**
     * Password login for admins (`login`) and citizens (`phone`), gated by the audience switch. Unknown
     * accounts cost the same argon2 verification and answer the same `INVALID_CREDENTIALS`, so the
     * endpoint does not enumerate accounts; the distinguishing detail stays in the log. Failures are
     * counted on the account, so guessing one login from many addresses still runs out of budget.
     */
    async login(input: LoginInput, client: ClientInfo): Promise<TokenPairResponse> {
        const user = input.login
            ? await this.users.findByLoginWithPassword(input.login)
            : await this.users.findByPhoneWithPassword(input.phone ?? '');

        if (!user?.password_hash) {
            await this.passwords.verifyDummy(input.password);
            this.logger.warn(
                { known: Boolean(user), reason: user ? 'no_password' : 'unknown_account' },
                'login rejected',
            );
            throw ApiError.unauthorized('INVALID_CREDENTIALS');
        }

        if (this.methodFor(user.role) !== 'password') {
            await this.passwords.verifyDummy(input.password);
            this.logger.warn({ known: true, reason: 'method_disabled' }, 'login rejected');
            throw ApiError.unauthorized('INVALID_CREDENTIALS');
        }

        const userId = user._id.toHexString();

        if (this.attempts.isLocked(user)) {
            await this.passwords.verifyDummy(input.password);
            await this.attempts.stall(user.failed_login_attempts);
            this.logger.warn({ user_id: userId, reason: 'locked' }, 'login rejected');
            throw ApiError.unauthorized('INVALID_CREDENTIALS');
        }

        if (!(await this.passwords.verify(user.password_hash, input.password))) {
            await this.attempts.registerFailure(userId);
            throw ApiError.unauthorized('INVALID_CREDENTIALS');
        }

        await this.attempts.registerSuccess({
            id: userId,
            failed_login_attempts: user.failed_login_attempts,
        });

        return this.startSession(user, client);
    }

    /** Citizen self-registration; exists only while `AUTH_CITIZEN_LOGIN_METHOD=password`. */
    async register(input: RegisterInput, client: ClientInfo): Promise<TokenPairResponse> {
        if (this.config.auth.citizenLoginMethod !== 'password')
            throw ApiError.forbidden('LOGIN_METHOD_DISABLED');

        const user = await this.users.createCitizen(input);

        return this.startSession(user, client);
    }

    /**
     * Writes a hashed code and sends the SMS; creates nothing. The ignored branch still spends one
     * argon2 hash and a delivery failure is only logged, so timing and status never reveal which phones
     * exist — under `citizen=password`, which of them belong to admins.
     */
    async requestOtp(phone: string): Promise<{ phone: string; expires_in: number }> {
        const { adminLoginMethod, citizenLoginMethod } = this.config.auth;

        if (adminLoginMethod !== 'sms' && citizenLoginMethod !== 'sms')
            throw ApiError.forbidden('LOGIN_METHOD_DISABLED');

        this.phonePolicy.assertSupported(phone);

        const response = { phone, expires_in: this.otp.ttlSeconds };
        const existing = await this.users.findByPhone(phone);
        const audienceMethod = existing ? this.methodFor(existing.role) : citizenLoginMethod;

        if (audienceMethod !== 'sms') {
            await this.otp.burnEquivalentWork();
            this.logger.info(
                { known: Boolean(existing) },
                'otp request ignored: sms login disabled for audience',
            );

            return response;
        }

        const code = await this.otp.issue(phone);

        try {
            await this.sms.send(phone, texts.sms.otp(code), 'verification');
        } catch (error) {
            this.logger.error({ err: error }, 'otp sms delivery failed');
        }

        return response;
    }

    /** Verifies the code; the citizen account is created here on first success. */
    async verifyOtp(input: OtpVerifyInput, client: ClientInfo): Promise<TokenPairResponse> {
        this.phonePolicy.assertSupported(input.phone);
        await this.otp.verify(input.phone, input.code);

        let user = await this.users.findByPhone(input.phone);

        if (user) {
            this.assertMethodEnabled(user.role, 'sms');

            if (input.name && input.name !== user.name) {
                await this.users.updateName(user._id.toHexString(), input.name);
                user = { ...user, name: input.name };
            }
        } else {
            if (this.config.auth.citizenLoginMethod !== 'sms')
                throw ApiError.forbidden('LOGIN_METHOD_DISABLED');

            user = await this.users.createCitizen({ phone: input.phone, name: input.name ?? '' });
        }

        return this.startSession(user, client);
    }

    /** Rotates the refresh token in one transaction; a reused token revokes the whole family. */
    async refresh(refreshToken: string, client: ClientInfo): Promise<TokenPairResponse> {
        const claims = await this.tokens.verifyRefresh(refreshToken);
        const session = await this.sessions.findWithHash(claims.sid);

        if (!session || session.user_id.toHexString() !== claims.sub)
            throw ApiError.unauthorized('TOKEN_INVALID');

        if (session.refresh_token_hash !== this.tokens.hashRefreshToken(refreshToken)) {
            throw ApiError.unauthorized('TOKEN_INVALID');
        }

        if (session.replaced_by || session.revoked_at) {
            await this.sessions.revokeFamily(session.family_id);
            this.logger.warn(
                { sid: claims.sid, user_id: claims.sub },
                'refresh token reuse detected; family revoked',
            );
            throw ApiError.unauthorized('REFRESH_TOKEN_REUSED');
        }

        if (session.expires_at.getTime() < Date.now()) throw ApiError.unauthorized('TOKEN_EXPIRED');

        const user = await this.users.findById(claims.sub);

        if (!user) throw ApiError.unauthorized('SESSION_REVOKED');

        const newSid = new Types.ObjectId();
        const pair = await this.tokens.issuePair(
            { id: user._id.toHexString(), role: user.role },
            newSid.toHexString(),
        );
        const rotated = await this.tx.run(async ({ session: dbSession }) => {
            if (!(await this.sessions.markReplaced(session._id, newSid, dbSession))) return false;

            await this.sessions.createSession(
                {
                    _id: newSid,
                    user_id: user._id,
                    family_id: session.family_id,
                    refresh_token_hash: this.tokens.hashRefreshToken(pair.refresh_token),
                    expires_at: pair.refresh_expires_at,
                    user_agent: client.user_agent,
                    ip: client.ip,
                },
                dbSession,
            );

            return true;
        });

        if (!rotated) {
            await this.sessions.revokeFamily(session.family_id);
            this.logger.warn(
                { sid: claims.sid, user_id: claims.sub },
                'refresh token reuse detected; family revoked',
            );
            throw ApiError.unauthorized('REFRESH_TOKEN_REUSED');
        }

        return this.toResponse(pair, user);
    }

    async logout(user: AuthUser): Promise<void> {
        await this.sessions.revoke(user.sid);
    }

    async logoutAll(user: AuthUser): Promise<void> {
        await this.sessions.revokeAllForUser(user.id);
    }

    me(user: AuthUser): Promise<UserEntity> {
        return this.users.getById(user.id);
    }

    /** Every other session of the account is revoked; the caller keeps the one they are using. */
    changePassword(user: AuthUser, currentPassword: string | undefined, newPassword: string): Promise<void> {
        return this.users.changePassword(user.id, currentPassword, newPassword, user.sid);
    }

    private async startSession(user: UserEntity, client: ClientInfo): Promise<TokenPairResponse> {
        const sid = new Types.ObjectId();
        const pair = await this.tokens.issuePair(
            { id: user._id.toHexString(), role: user.role },
            sid.toHexString(),
        );
        await this.sessions.createSession({
            _id: sid,
            user_id: user._id,
            family_id: sid,
            refresh_token_hash: this.tokens.hashRefreshToken(pair.refresh_token),
            expires_at: pair.refresh_expires_at,
            user_agent: client.user_agent,
            ip: client.ip,
        });

        return this.toResponse(pair, user);
    }

    private toResponse(
        pair: { access_token: string; refresh_token: string; expires_in: number },
        user: UserEntity,
    ): TokenPairResponse {
        return {
            access_token: pair.access_token,
            refresh_token: pair.refresh_token,
            token_type: 'Bearer',
            expires_in: pair.expires_in,
            user: {
                id: user._id.toHexString(),
                login: user.login,
                name: user.name,
                phone: user.phone,
                role: user.role,
                organization_ids: user.organization_ids.map((id) => id.toHexString()),
                created_at: user.created_at.toISOString(),
                updated_at: user.updated_at.toISOString(),
            },
        };
    }

    private methodFor(role: Role): LoginMethod {
        return role === ROLES.COMMON_USER
            ? this.config.auth.citizenLoginMethod
            : this.config.auth.adminLoginMethod;
    }

    private assertMethodEnabled(role: Role, method: LoginMethod): void {
        if (this.methodFor(role) !== method) throw ApiError.forbidden('LOGIN_METHOD_DISABLED');
    }
}
