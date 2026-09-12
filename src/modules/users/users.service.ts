import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { AppConfig } from '../../common/config/app-config';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { type Role, ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
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

const USER_SORTABLE = ['created_at', 'name', 'login', 'role'] as const;

/** `GET /users/:id/bookings` keeps the field names it had while bookings lived on the account. */
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
        private readonly config: AppConfig,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('organization', 'users.detach_organization', async (organizationId, ctx) => {
            await this.users.detachOrganization(organizationId, ctx.session);
        });
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
        const filter: Record<string, unknown> = {};

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
            role: input.role,
            organization_ids: (input.organization_ids ?? []).map((id) => new Types.ObjectId(id)),
        });
    }

    async createCitizen(input: { phone: string; name: string; password?: string }): Promise<UserEntity> {
        this.phonePolicy.assertSupported(input.phone);

        if (input.password) this.passwords.assertPolicy(input.password);

        await this.assertUnique(undefined, input.phone);

        return this.users.create({
            phone: input.phone,
            name: input.name,
            password_hash: input.password ? await this.passwords.hash(input.password) : undefined,
            role: ROLES.COMMON_USER,
            organization_ids: [],
        });
    }

    async updateSelf(id: string, input: UpdateSelfInput): Promise<UserEntity> {
        await this.getById(id);
        const set = input.name === undefined ? {} : { name: input.name };
        const updated = await this.users.updateFields(id, set);

        if (!updated) throw ApiError.notFound('USER_NOT_FOUND');

        return updated;
    }

    /**
     * Super-admin edit of any account. The stored hash is loaded explicitly (it is `select: false`), so
     * "this admin can sign in" is a real check against the configured login method, not an assumption.
     */
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

    /** Reads the account's bookings from their own collection, newest first. */
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

    async updateName(id: string, name: string): Promise<void> {
        await this.users.updateFields(id, { name });
    }

    /**
     * An account must end up with the identifiers its own login method needs: under `admin=password`, an
     * admin without a login and a password could sign in neither by password nor by one-time code.
     */
    private assertIdentifiers(role: Role, login?: string, password?: string, phone?: string): void {
        if (role === ROLES.COMMON_USER) {
            if (!phone) throw ApiError.unprocessable('CITIZEN_PHONE_REQUIRED');

            return;
        }

        if (this.config.auth.adminLoginMethod === 'sms') {
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
        if (login.length < this.passwords.loginMinLength) throw ApiError.unprocessable('LOGIN_TOO_SHORT');
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
