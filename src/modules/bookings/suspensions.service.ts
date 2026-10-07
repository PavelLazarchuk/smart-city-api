import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type ClientSession, type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { isStaffOf } from '../../common/content/visibility';
import { type TransactionContext, TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { OutboxService } from '../../common/outbox/outbox.service';
import { type OutboxEventEntity } from '../../common/outbox/outbox.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { dateOnlyIn } from '../../common/time/zone';
import { MailService } from '../../integrations/mail/mail.service';
import { type BookingEntity, BookingsRepository } from './bookings.repository';
import {
    type CreateSuspensionInput,
    type ListSuspensionsQuery,
    type SuspensionResource,
} from './dto/suspension.schemas';
import { type BookingStatus } from './schemas/booking.schema';
import { type BookingSuspension } from './schemas/suspension.schema';
import { type BookingSuspensionEntity, SuspensionsRepository } from './suspensions.repository';
import { WaitlistRepository } from './waitlist.repository';
import { OrganizationsService } from '../organizations/organizations.service';
import { ChannelTemplatesService } from '../channel-templates/channel-templates.service';
import { SmsService } from '../sms/sms.service';
import { type UserEntity } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { organizationOf, recipientEmail, text } from './booking-events';
import {
    inForce,
    liftedByCorrection,
    manualSuspensionEnd,
    noShowCountedSince,
    noShowEnabled,
    noShowSanction,
    type SuspensionChange,
} from './booking-policy';
import { type ServiceEntity } from '../services/services.repository';
import { ServicesService } from '../services/services.service';

const SUSPENSION_SORTABLE = ['suspended_at', 'until'] as const;

function toResource(row: BookingSuspensionEntity, now = new Date()): SuspensionResource {
    return {
        id: row.id,
        user_id: row.user_id.toHexString(),
        service_id: row.service_id.toHexString(),
        organization_id: row.organization_id.toHexString(),
        service_label: row.service_label,
        active: inForce(row, now),
        kind: row.kind ?? null,
        reason: row.reason ?? null,
        until: row.until ? row.until.toISOString() : null,
        booking_ids: row.booking_ids ?? [],
        suspended_at: row.suspended_at ? row.suspended_at.toISOString() : null,
        suspended_by: row.suspended_by ? row.suspended_by.toHexString() : null,
        lifted_at: row.lifted_at ? row.lifted_at.toISOString() : null,
        lifted_by: row.lifted_by ? row.lifted_by.toHexString() : null,
    };
}

function suspensionNotice(event: OutboxEventEntity): {
    service: string;
    until?: string;
    missed?: number;
    reason?: string;
    phone: string;
} {
    const until = text(event.payload['until_date']);
    const reason = text(event.payload['reason']);
    const bookings = event.payload['booking_ids'];

    return {
        service: text(event.payload['service_label']),
        until: until || undefined,
        missed:
            event.payload['kind'] === 'no_show' && Array.isArray(bookings) && bookings.length > 0
                ? bookings.length
                : undefined,
        reason: reason || undefined,
        phone: text(event.internal?.['phone']),
    };
}

@Injectable()
export class SuspensionsService implements OnModuleInit {
    constructor(
        private readonly suspensions: SuspensionsRepository,
        private readonly bookings: BookingsRepository,
        private readonly waitlist: WaitlistRepository,
        private readonly services: ServicesService,
        private readonly users: UsersService,
        private readonly organizations: OrganizationsService,
        private readonly outbox: OutboxService,
        private readonly mail: MailService,
        private readonly sms: SmsService,
        private readonly templates: ChannelTemplatesService,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('user', 'suspensions.delete', async (userId, ctx) => {
            await this.suspensions.deleteByUser(userId, ctx.session);
        });
        this.cascade.register('service', 'suspensions.delete', async (serviceId, ctx) => {
            await this.suspensions.deleteByService(serviceId, ctx.session);
        });
        this.cascade.register('organization', 'suspensions.delete', async (organizationId, ctx) => {
            await this.suspensions.deleteByOrganization(organizationId, ctx.session);
        });

        this.outbox.registerHandler('booking.suspended', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!email) return;

            const message = await this.templates.mail(
                organizationOf(event),
                'booking_suspended_mail',
                suspensionNotice(event),
            );
            await this.mail.send({ to: [email], ...message });
        });
        this.outbox.registerHandler('booking.suspended', 'sms', async (event) => {
            const { phone, ...data } = suspensionNotice(event);

            if (recipientEmail(event) || !phone) return;

            await this.sms.notify(phone, 'suspension', (channel) =>
                this.templates.text(organizationOf(event), `booking_suspended_${channel}`, data),
            );
        });
    }

    async assertNotSuspended(
        userId: string,
        serviceId: string,
        now: Date,
        session: ClientSession,
    ): Promise<void> {
        const row = await this.suspensions.findForClient(userId, serviceId, session);

        if (!inForce(row, now)) return;

        throw ApiError.unprocessable('BOOKING_SUSPENDED', [
            { path: 'until', message: row.until ? row.until.toISOString() : 'until lifted' },
        ]);
    }

    async onStatusChanged(
        booking: BookingEntity,
        previous: BookingStatus,
        actor: AuthUser | null,
        ctx: TransactionContext,
    ): Promise<void> {
        if (booking.status === 'no_show') {
            await this.countNoShow(booking, ctx);

            return;
        }

        if (previous !== 'no_show') return;

        const now = new Date();
        const row = await this.suspensions.findForClient(
            booking.user_id.toHexString(),
            booking.service_id.toHexString(),
            ctx.session,
        );

        if (liftedByCorrection(row, booking.id, now)) await this.release(row, actor, now, ctx);
    }

    async onLateCancel(booking: BookingEntity, ctx: TransactionContext): Promise<void> {
        await this.countNoShow(booking, ctx);
    }

    async create(input: CreateSuspensionInput, actor: AuthUser): Promise<SuspensionResource> {
        const service = await this.services.findById(input.service_id);

        if (!service || service.deleted_at || !isStaffOf(actor, service.organization_id.toHexString()))
            throw ApiError.notFound('SERVICE_NOT_FOUND');

        const client = await this.clientOf(input);
        const row = await this.tx.run(async (ctx) => {
            const now = new Date();
            const subject = await this.suspensions.touch(
                this.subjectOf(service, client._id),
                now,
                ctx.session,
            );

            return this.suspend(
                subject,
                {
                    until: manualSuspensionEnd(input.days, now),
                    kind: 'manual',
                    reason: input.reason,
                    booking_ids: [],
                    suspended_by: new Types.ObjectId(actor.id),
                },
                input.notify === false ? null : client,
                actor,
                now,
                ctx,
            );
        });

        return toResource(row);
    }

    async list(query: ListSuspensionsQuery, actor: AuthUser): Promise<PaginatedResult<SuspensionResource>> {
        const pagination = this.pagination.resolve(query, {
            sortable: SUSPENSION_SORTABLE,
            defaultSort: 'suspended_at',
        });
        const now = new Date();
        const filter: FilterQuery<BookingSuspension> = {
            ...this.organizationScope(query.organization_id, actor),
            suspended_at: { $ne: null },
        };

        if (query.service_id) filter['service_id'] = new Types.ObjectId(query.service_id);

        if (query.user_id) filter['user_id'] = new Types.ObjectId(query.user_id);

        if ((query.status ?? 'active') === 'active') {
            filter['suspended'] = true;
            filter['$or'] = [{ until: null }, { until: { $gt: now } }];
        }

        const result = await this.suspensions.list(filter, pagination);

        return { ...result, items: result.items.map((row) => toResource(row, now)) };
    }

    async getById(id: string, actor: AuthUser): Promise<SuspensionResource> {
        const row = await this.suspensions.findByPublicId(id);

        if (!row || !isStaffOf(actor, row.organization_id.toHexString()))
            throw ApiError.notFound('SUSPENSION_NOT_FOUND');

        return toResource(row);
    }

    async lift(id: string, actor: AuthUser): Promise<void> {
        await this.tx.run(async (ctx) => {
            const row = await this.suspensions.findByPublicId(id, ctx.session);

            if (!row || !isStaffOf(actor, row.organization_id.toHexString()))
                throw ApiError.notFound('SUSPENSION_NOT_FOUND');

            const now = new Date();

            if (inForce(row, now)) await this.release(row, actor, now, ctx);
        });
    }

    private async countNoShow(booking: BookingEntity, ctx: TransactionContext): Promise<void> {
        const service = await this.services.findById(booking.service_id.toHexString(), ctx.session);
        const policy = service?.booking_policy;

        if (!service || !noShowEnabled(policy)) return;

        const now = new Date();
        const row = await this.suspensions.touch(this.subjectOf(service, booking.user_id), now, ctx.session);
        const missed = await this.bookings.findNoShowIds(
            booking.user_id.toHexString(),
            booking.service_id.toHexString(),
            noShowCountedSince(row.counted_from, policy, now),
            ctx.session,
        );
        const change = noShowSanction(policy, row, missed, now);

        if (!change) return;

        const client = await this.users.findById(booking.user_id.toHexString());

        await this.suspend(
            row,
            change,
            client ?? { _id: booking.user_id, phone: booking.phone, email: undefined, name: booking.person },
            null,
            now,
            ctx,
        );
    }

    private async suspend(
        row: BookingSuspensionEntity,
        change: SuspensionChange,
        recipient: Pick<UserEntity, '_id' | 'phone' | 'email' | 'name'> | null,
        actor: AuthUser | null,
        now: Date,
        ctx: TransactionContext,
    ): Promise<BookingSuspensionEntity> {
        const updated = await this.suspensions.update(
            row.id,
            {
                ...change,
                suspended: true,
                counted_from: now,
                suspended_at: now,
                lifted_at: null,
                lifted_by: null,
            },
            ctx.session,
        );

        if (!updated) throw ApiError.conflict('CONFLICT');

        await this.waitlist.deleteByUserAndService(updated.user_id, updated.service_id, ctx.session);
        await this.emit('booking.suspended', updated, recipient, actor, ctx);

        return updated;
    }

    private async release(
        row: BookingSuspensionEntity,
        actor: AuthUser | null,
        now: Date,
        ctx: TransactionContext,
    ): Promise<void> {
        const updated = await this.suspensions.update(
            row.id,
            {
                suspended: false,
                counted_from: now,
                lifted_at: now,
                lifted_by: actor ? new Types.ObjectId(actor.id) : null,
            },
            ctx.session,
        );

        if (updated) await this.emit('booking.suspension_lifted', updated, null, actor, ctx);
    }

    private async emit(
        type: 'booking.suspended' | 'booking.suspension_lifted',
        row: BookingSuspensionEntity,
        recipient: Pick<UserEntity, 'phone' | 'email' | 'name'> | null,
        actor: AuthUser | null,
        ctx: TransactionContext,
    ): Promise<void> {
        const organizationId = row.organization_id.toHexString();
        const timeZone = row.until ? await this.organizations.timezoneOf(organizationId) : null;
        const internal = {
            ...(recipient
                ? {
                      phone: recipient.phone ?? null,
                      email: recipient.email ?? null,
                      person: recipient.name ?? null,
                  }
                : {}),
            ...(actor ? { actor: { id: actor.id, kind: 'staff' } } : {}),
        };

        await this.outbox.enqueue(
            type,
            {
                suspension_id: row.id,
                user_id: row.user_id.toHexString(),
                service_id: row.service_id.toHexString(),
                organization_id: organizationId,
                service_label: row.service_label,
                kind: row.kind,
                reason: row.reason,
                until: row.until ? row.until.toISOString() : null,
                until_date: row.until && timeZone ? dateOnlyIn(row.until, timeZone) : null,
                booking_ids: row.booking_ids,
            },
            {
                organizationId: row.organization_id,
                internal: Object.keys(internal).length > 0 ? internal : undefined,
                session: ctx.session,
            },
        );
        ctx.afterCommit(() => this.outbox.poke());
    }

    private async clientOf(input: CreateSuspensionInput): Promise<UserEntity> {
        const user = input.user_id
            ? await this.users.findById(input.user_id)
            : await this.users.findByPhone(input.phone ?? '');

        if (!user) throw ApiError.notFound('USER_NOT_FOUND');

        if (user.role !== ROLES.COMMON_USER) throw ApiError.unprocessable('CLIENT_ACCOUNT_REQUIRED');

        return user;
    }

    private subjectOf(service: ServiceEntity, userId: Types.ObjectId) {
        return {
            user_id: userId,
            service_id: service._id,
            organization_id: service.organization_id,
            service_label: service.value.heading_value ?? service.label,
        };
    }

    private organizationScope(
        organizationId: string | undefined,
        actor: AuthUser,
    ): FilterQuery<BookingSuspension> {
        if (actor.role === ROLES.SUPER_ADMIN) {
            return organizationId ? { organization_id: new Types.ObjectId(organizationId) } : {};
        }

        if (organizationId) {
            if (!actor.organization_ids.includes(organizationId)) throw ApiError.forbidden('FORBIDDEN');

            return { organization_id: new Types.ObjectId(organizationId) };
        }

        return { organization_id: { $in: actor.organization_ids.map((id) => new Types.ObjectId(id)) } };
    }
}
