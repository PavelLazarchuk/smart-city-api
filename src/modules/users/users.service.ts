import { Injectable, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { type ClientSession, type FilterQuery, Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { type Role, ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { type SettingsWarning } from '../../common/settings/dto/settings.schemas';
import {
    settingLockoutRisk,
    type SettingsChange,
    SettingsService,
} from '../../common/settings/settings.service';
import { AuthStoreService } from '../auth/store/auth-store.service';
import { BookingsRepository } from '../bookings/bookings.repository';
import { PasswordService } from '../auth/password.service';
import { PhonePolicy } from '../auth/phone.policy';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type CreateUserInput,
    type ListUsersQuery,
    type UpdateSelfInput,
    type UpdateUserAdminInput,
} from './dto/user.schemas';
import { type UserEntity, UsersRepository } from './users.repository';
import { type User } from './schemas/user.schema';

const LOGIN_MIN_LENGTH = 6;
const DUPLICATE_KEY = 11000;
const CALENDAR_TOKEN_BYTES = 32;
const WARNING_USER_LIMIT = 50;
const ACTIVE_CLIENTS_WINDOW_MS = 24 * 3600_000;

function calendarTokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

const USER_SORTABLE = ['created_at', 'name', 'login', 'role'] as const;

export interface UserBookingView {
    id: string;
    service_id: Types.ObjectId;
    organization_id: Types.ObjectId;
    option_id: string;
    slot_id: string;
    child_type: string;
    service_label: string;
    date?: string;
    time?: string;
    info: string;
    status: string;
    created_at: Date;
}

@Injectable()
export class UsersService implements OnModuleInit {
    constructor(
        private readonly users: UsersRepository,
        private readonly bookings: BookingsRepository,
        private readonly passwords: PasswordService,
        private readonly phonePolicy: PhonePolicy,
        private readonly authStore: AuthStoreService,
        private readonly organizations: OrganizationsService,
        private readonly settings: SettingsService,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(UsersService.name);
    }

    onModuleInit(): void {
        this.cascade.register('organization', 'users.detach_organization', async (organizationId, ctx) => {
            await this.users.detachOrganization(organizationId, ctx.session);
        });
        this.settings.registerWriteCheck('users.sign_in_access', (change, actor) =>
            this.checkSignInAccess(change, actor),
        );
    }

    private async checkSignInAccess(change: SettingsChange, actor: AuthUser): Promise<SettingsWarning[]> {
        const warnings: SettingsWarning[] = [];
        const adminMethod = change.after['auth.admin_login_method'];

        if (adminMethod !== change.before['auth.admin_login_method']) {
            const self = await this.users.findByIdWithPassword(actor.id);

            if (adminMethod === 'sms') {
                if (!self?.phone || !this.phonePolicy.isSupported(self.phone))
                    throw settingLockoutRisk([
                        {
                            path: 'auth.admin_login_method',
                            message: 'You have no phone number that can receive codes',
                        },
                    ]);

                const others = await this.users.countOtherSuperAdmins(actor.id);

                if (
                    others > 0 &&
                    (await this.users.countOtherSuperAdmins(actor.id, this.phonePolicy.countryCode)) === 0
                )
                    throw settingLockoutRisk([
                        {
                            path: 'auth.admin_login_method',
                            message: 'No other super admin has a phone number that can receive codes',
                        },
                    ]);
            } else if (!self?.login || !self.password_hash) {
                throw settingLockoutRisk([
                    { path: 'auth.admin_login_method', message: 'You have no login and password' },
                ]);
            }

            const stranded = await this.users.staffIdsWithout(
                adminMethod === 'sms' ? 'phone' : 'password',
                actor.id,
                WARNING_USER_LIMIT,
            );

            if (stranded.length > 0)
                warnings.push({
                    code: 'STAFF_CANNOT_SIGN_IN',
                    message:
                        adminMethod === 'sms'
                            ? 'These staff members have no phone number and cannot sign in'
                            : 'These staff members have no login and password and cannot sign in',
                    user_ids: stranded,
                });
        }

        const clientMethod = change.after['auth.client_login_method'];
        const dailyLimit = change.after['sms.daily_limit'];

        if (clientMethod === 'sms' && change.before['auth.client_login_method'] !== 'sms' && dailyLimit > 0) {
            const since = new Date(Date.now() - ACTIVE_CLIENTS_WINDOW_MS);
            const activeClients = await this.authStore.countUsersSignedInSince(since, ROLES.COMMON_USER);

            if (activeClients > dailyLimit)
                this.logger.warn(
                    { active_clients: activeClients, sms_daily_limit: dailyLimit },
                    'sms client login enabled with a daily sms limit below the active clients of the last day',
                );
        }

        return warnings;
    }

    async resolveAuthUser(userId: string, sid: string): Promise<AuthUser | null> {
        const [user, session] = await Promise.all([
            this.users.findById(userId),
            this.authStore.findActiveSession(sid),
        ]);

        if (!user || !session || session.user_id.toHexString() !== user._id.toHexString()) return null;

        return {
            id: user._id.toHexString(),
            role: user.role,
            organization_ids: user.organization_ids.map((id) => id.toHexString()),
            sid,
            name: user.name,
            phone: user.phone,
            login: user.login,
        };
    }

    async getById(id: string): Promise<UserEntity> {
        const user = await this.users.findById(id);

        if (!user) throw ApiError.notFound('USER_NOT_FOUND');

        return user;
    }

    async list(query: ListUsersQuery): Promise<PaginatedResult<UserEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: USER_SORTABLE,
            defaultSort: 'created_at',
        });
        const filter: FilterQuery<User> = {};

        if (query.role) filter['role'] = query.role;

        if (query.organization_id) filter['organization_ids'] = new Types.ObjectId(query.organization_id);

        return this.users.list(filter, pagination);
    }

    async create(input: CreateUserInput): Promise<UserEntity> {
        this.assertIdentifiers(input.role, input.login, input.password, input.phone);

        if (input.phone) this.phonePolicy.assertSupported(input.phone);

        if (input.password) this.passwords.assertPolicy(input.password);

        if (input.login) this.assertLoginPolicy(input.login);

        await this.assertUnique(input.login, input.phone);

        if (input.organization_ids?.length) await this.organizations.assertAllExist(input.organization_ids);

        return this.users.create({
            login: input.login,
            password_hash: input.password ? await this.passwords.hash(input.password) : undefined,
            name: input.name,
            phone: input.phone,
            email: input.email,
            role: input.role,
            organization_ids: (input.organization_ids ?? []).map((id) => new Types.ObjectId(id)),
        });
    }

    async createClient(input: {
        phone: string;
        name: string;
        password?: string;
        email?: string;
    }): Promise<UserEntity> {
        this.phonePolicy.assertSupported(input.phone);

        if (input.password) this.passwords.assertPolicy(input.password);

        await this.assertUnique(undefined, input.phone);

        return this.users.create({
            phone: input.phone,
            name: input.name,
            email: input.email,
            password_hash: input.password ? await this.passwords.hash(input.password) : undefined,
            role: ROLES.COMMON_USER,
            organization_ids: [],
        });
    }

    async findOrCreateClient(
        input: { phone: string; name: string },
        session?: ClientSession,
    ): Promise<UserEntity> {
        const existing = await this.users.findByPhone(input.phone, session);

        if (existing && existing.role !== ROLES.COMMON_USER)
            throw ApiError.unprocessable('CLIENT_ACCOUNT_REQUIRED');

        if (existing) return existing;

        this.phonePolicy.assertSupported(input.phone);

        return this.users.create(
            { phone: input.phone, name: input.name, role: ROLES.COMMON_USER, organization_ids: [] },
            session,
        );
    }

    async issueCalendarToken(id: string): Promise<string> {
        const token = randomBytes(CALENDAR_TOKEN_BYTES).toString('base64url');
        const updated = await this.users.updateFields(id, { calendar_token_hash: calendarTokenHash(token) });

        if (!updated) throw ApiError.notFound('USER_NOT_FOUND');

        return token;
    }

    async revokeCalendarToken(id: string): Promise<void> {
        await this.users.updateFields(id, {}, ['calendar_token_hash']);
    }

    findByCalendarToken(token: string): Promise<UserEntity | null> {
        return this.users.findOne({ calendar_token_hash: calendarTokenHash(token) });
    }

    async updateSelf(id: string, input: UpdateSelfInput & { phone?: string }): Promise<UserEntity> {
        const existing = await this.getById(id);
        const set: Record<string, unknown> = {};
        const unset: string[] = [];

        if (input.name !== undefined) set['name'] = input.name;

        if (input.reminders !== undefined) set['reminders'] = input.reminders;

        if (input.email !== undefined) {
            if (input.email === null) unset.push('email');
            else set['email'] = input.email;
        }

        if (input.phone !== undefined && input.phone !== existing.phone) {
            this.phonePolicy.assertSupported(input.phone);
            await this.assertUnique(undefined, input.phone, id);
            set['phone'] = input.phone;
        }

        let updated: UserEntity | null;

        try {
            updated = await this.users.updateFields(id, set, unset);
        } catch (error) {
            if ((error as { code?: number }).code === DUPLICATE_KEY) throw ApiError.conflict('PHONE_TAKEN');

            throw error;
        }

        if (!updated) throw ApiError.notFound('USER_NOT_FOUND');

        return updated;
    }

    /** The hash is loaded explicitly (`select: false`), so "this admin can sign in" is a real check. */
    async updateByAdmin(id: string, input: UpdateUserAdminInput, actor?: AuthUser): Promise<UserEntity> {
        const existing = await this.users.findByIdWithPassword(id);

        if (!existing) throw ApiError.notFound('USER_NOT_FOUND');

        if (input.role !== undefined && input.role !== existing.role) {
            if (actor && actor.id === id) throw ApiError.unprocessable('SELF_ROLE_CHANGE');

            if (existing.role === ROLES.SUPER_ADMIN) await this.assertNotLastSuperAdmin(id);
        }

        const set: Record<string, unknown> = {};
        const unset: string[] = [];

        if (input.login !== undefined) {
            if (input.login === null) unset.push('login');
            else {
                this.assertLoginPolicy(input.login);
                set['login'] = input.login;
            }
        }

        if (input.phone !== undefined) {
            if (input.phone === null) unset.push('phone');
            else {
                this.phonePolicy.assertSupported(input.phone);
                set['phone'] = input.phone;
            }
        }

        if (input.name !== undefined) {
            if (input.name === null) unset.push('name');
            else set['name'] = input.name;
        }

        if (input.email !== undefined) {
            if (input.email === null) unset.push('email');
            else set['email'] = input.email;
        }

        if (input.password !== undefined) {
            this.passwords.assertPolicy(input.password);
            set['password_hash'] = await this.passwords.hash(input.password);
        }

        if (input.role !== undefined) set['role'] = input.role;

        const role = (set['role'] as Role | undefined) ?? existing.role;
        const login = unset.includes('login')
            ? undefined
            : ((set['login'] as string | undefined) ?? existing.login);
        const phone = unset.includes('phone')
            ? undefined
            : ((set['phone'] as string | undefined) ?? existing.phone);
        const hasPassword = set['password_hash'] !== undefined || existing.password_hash !== undefined;
        this.assertIdentifiers(role, login, hasPassword ? 'set' : undefined, phone);
        await this.assertUnique(set['login'] as string | undefined, set['phone'] as string | undefined, id);

        const updated = await this.users.updateFields(id, set, unset);

        if (!updated) throw ApiError.notFound('USER_NOT_FOUND');

        if (set['password_hash'] !== undefined || input.login !== undefined || input.role !== undefined) {
            await this.authStore.revokeAllSessions(id);
        }

        return updated;
    }

    async setOrganizations(id: string, organizationIds: string[]): Promise<UserEntity> {
        await this.getById(id);
        const unique = [...new Set(organizationIds)];
        await this.organizations.assertAllExist(unique);
        const updated = await this.users.setOrganizationIds(id, unique);

        if (!updated) throw ApiError.notFound('USER_NOT_FOUND');

        return updated;
    }

    async delete(id: string): Promise<void> {
        const user = await this.getById(id);

        if (user.role === ROLES.SUPER_ADMIN) await this.assertNotLastSuperAdmin(id);

        await this.tx.run(async (ctx) => {
            await this.cascade.run('user', id, ctx);
            await this.authStore.revokeAllSessions(id, ctx.session);

            if (user.phone) await this.authStore.deleteCodesForPhone(user.phone, ctx.session);

            await this.users.deleteById(id, ctx.session);
        });
    }

    async getBookings(id: string): Promise<UserBookingView[]> {
        await this.getById(id);
        const bookings = await this.bookings.findByUser(id);

        return bookings.map((booking) => ({
            id: booking.id,
            service_id: booking.service_id,
            organization_id: booking.organization_id,
            option_id: booking.option_id,
            slot_id: booking.slot_id,
            child_type: booking.child_type,
            service_label: booking.service_label,
            date: booking.slot_date ?? undefined,
            time: booking.slot_time ?? undefined,
            info: booking.info,
            status: booking.status,
            created_at: booking.created_at,
        }));
    }

    /** Changing the password ends every other session: a stolen refresh token must stop working. */
    async changePassword(
        id: string,
        currentPassword: string | undefined,
        newPassword: string,
        keepSessionId?: string,
    ): Promise<void> {
        const user = await this.users.findByIdWithPassword(id);

        if (!user) throw ApiError.notFound('USER_NOT_FOUND');

        this.passwords.assertPolicy(newPassword);

        if (user.password_hash) {
            if (!currentPassword || !(await this.passwords.verify(user.password_hash, currentPassword))) {
                throw ApiError.unauthorized('INVALID_CREDENTIALS');
            }

            if (await this.passwords.verify(user.password_hash, newPassword)) {
                throw ApiError.unprocessable('PASSWORD_UNCHANGED');
            }
        }

        await this.users.updateFields(id, { password_hash: await this.passwords.hash(newPassword) });
        await this.authStore.revokeAllSessions(id, undefined, keepSessionId);
    }

    findByLoginWithPassword(login: string): Promise<(UserEntity & { password_hash?: string }) | null> {
        return this.users.findByLoginWithPassword(login);
    }

    findByPhoneWithPassword(phone: string): Promise<(UserEntity & { password_hash?: string }) | null> {
        return this.users.findByPhoneWithPassword(phone);
    }

    registerFailedLogin(id: string, windowStart: Date, now: Date): Promise<number | null> {
        return this.users.incrementFailedLogins(id, windowStart, now);
    }

    lockAccount(id: string, until: Date): Promise<void> {
        return this.users.lockUntil(id, until);
    }

    clearFailedLogins(id: string): Promise<void> {
        return this.users.clearFailedLogins(id);
    }

    findByPhone(phone: string): Promise<UserEntity | null> {
        return this.users.findByPhone(phone);
    }

    findById(id: string): Promise<UserEntity | null> {
        return this.users.findById(id);
    }

    findEmailsByIds(ids: string[]): Promise<Map<string, string>> {
        return this.users.findEmailsByIds(ids);
    }

    findWithoutReminders(ids: string[]): Promise<Set<string>> {
        return this.users.findWithoutReminders(ids);
    }

    /** Under `admin=password` an admin without a login and a password could sign in by neither method. */
    private assertIdentifiers(role: Role, login?: string, password?: string, phone?: string): void {
        if (role === ROLES.COMMON_USER) {
            if (!phone) throw ApiError.unprocessable('CLIENT_PHONE_REQUIRED');

            return;
        }

        if (this.settings.get('auth.admin_login_method') === 'sms') {
            if (!phone) throw ApiError.unprocessable('ADMIN_PHONE_REQUIRED');

            return;
        }

        if (!login || !password) throw ApiError.unprocessable('ADMIN_PASSWORD_REQUIRED');
    }

    private async assertNotLastSuperAdmin(id: string): Promise<void> {
        const others = await this.users.countOtherSuperAdmins(id);

        if (others === 0) throw ApiError.conflict('LAST_SUPER_ADMIN');
    }

    private assertLoginPolicy(login: string): void {
        if (login.length < LOGIN_MIN_LENGTH) throw ApiError.unprocessable('LOGIN_TOO_SHORT');
    }

    private async assertUnique(login?: string, phone?: string, exceptId?: string): Promise<void> {
        if (login) {
            const found = await this.users.findByLogin(login);

            if (found && found._id.toHexString() !== exceptId) throw ApiError.conflict('LOGIN_TAKEN');
        }

        if (phone) {
            const found = await this.users.findByPhone(phone);

            if (found && found._id.toHexString() !== exceptId) throw ApiError.conflict('PHONE_TAKEN');
        }
    }
}
