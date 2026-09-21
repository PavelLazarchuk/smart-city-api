import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type ClientSession, type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { type TransactionContext, TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ApiError, type ApiErrorDetail } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { MailService } from '../../integrations/mail/mail.service';
import { type BookingEntity, BookingsRepository } from '../bookings/bookings.repository';
import {
    type BookingResource,
    type BookingStats,
    type BookingStatsQuery,
    type JoinWaitlistInput,
    type ListBookingsQuery,
    type ListOwnBookingsQuery,
    type ListServiceBookingsQuery,
    type ListWaitlistQuery,
    type RescheduleBookingInput,
    type WaitlistEntryResource,
} from '../bookings/dto/booking.schemas';
import {
    ACTIVE_BOOKING_STATUSES,
    type Booking,
    type BookingStatus,
} from '../bookings/schemas/booking.schema';
import { type WaitlistEntry } from '../bookings/schemas/waitlist.schema';
import { type WaitlistEntryEntity, WaitlistRepository } from '../bookings/waitlist.repository';
import { OrganizationsService } from '../organizations/organizations.service';
import { SmsService } from '../sms/sms.service';
import { UsersService } from '../users/users.service';
import { eventPayload, notice, recipientEmail, text } from './booking-events';
import { validateBookingFields, validateDocuments } from './booking-form';
import { type BookingCreated, type CreateBookingInput } from './dto/service.schemas';
import { BOOKABLE_SLOT_TYPES, type ServiceOption, type Slot } from './schemas/service.schema';
import { ServicesMasker } from './services.masker';
import { type ServiceEntity, ServicesRepository } from './services.repository';
import { formatDateOnly } from './slot.logic';

const DUPLICATE_KEY = 11000;
const BOOKING_SORTABLE = ['created_at', 'slot_date'] as const;

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['completed', 'no_show', 'cancelled'],
    completed: ['no_show'],
    no_show: ['completed'],
    cancelled: [],
};

interface StatusFilter {
    status?: BookingStatus | 'active' | 'all';
}

interface DateRange {
    date_from?: string;
    date_to?: string;
}

interface Target {
    option: ServiceOption;
    slot: Slot;
    time: string | undefined;
    limit: number | null;
}

interface Cancelled {
    user_id: string;
    date?: string;
    time?: string;
    child_type: string;
}

function toResource(booking: BookingEntity): BookingResource {
    return {
        id: booking.id,
        service_id: booking.service_id.toHexString(),
        organization_id: booking.organization_id.toHexString(),
        option_id: booking.option_id,
        slot_id: booking.slot_id,
        child_type: booking.child_type,
        service_label: booking.service_label,
        date: booking.slot_date,
        time: booking.slot_time,
        user_id: booking.user_id.toHexString(),
        person: booking.person,
        phone: booking.phone,
        info: booking.info,
        fields: booking.fields ?? {},
        documents: booking.documents ?? [],
        status: booking.status,
        confirmed_at: booking.confirmed_at ? booking.confirmed_at.toISOString() : null,
        finished_at: booking.finished_at ? booking.finished_at.toISOString() : null,
        created_at: booking.created_at.toISOString(),
    };
}

function toWaitlistResource(entry: WaitlistEntryEntity): WaitlistEntryResource {
    return {
        id: entry.id,
        service_id: entry.service_id.toHexString(),
        organization_id: entry.organization_id.toHexString(),
        option_id: entry.option_id,
        slot_id: entry.slot_id,
        service_label: entry.service_label,
        date: entry.slot_date,
        time: entry.slot_time,
        user_id: entry.user_id.toHexString(),
        person: entry.person,
        phone: entry.phone,
        status: entry.status,
        notified_at: entry.notified_at ? entry.notified_at.toISOString() : null,
        created_at: entry.created_at.toISOString(),
    };
}

function slotStart(date: string | null | undefined, time: string | null | undefined): Date | null {
    if (!date) return null;

    const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
    const [hours = 0, minutes = 0] = (time ?? '00:00').split(':').map(Number);

    return new Date(year, month - 1, day, hours, minutes);
}

/**
 * Row and `booked_count` change in one transaction: the counter enforces capacity, the partial unique index
 * refuses duplicates, and notifications are outbox events delivered after the commit.
 */
@Injectable()
export class BookingsService implements OnModuleInit {
    constructor(
        private readonly repository: ServicesRepository,
        private readonly bookings: BookingsRepository,
        private readonly waitlist: WaitlistRepository,
        private readonly organizations: OrganizationsService,
        private readonly users: UsersService,
        private readonly mail: MailService,
        private readonly sms: SmsService,
        private readonly outbox: OutboxService,
        private readonly masker: ServicesMasker,
        private readonly pagination: PaginationService,
        private readonly idempotency: IdempotencyService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('user', 'bookings.delete', async (userId, ctx) => {
            const active = await this.bookings.findByUser(userId, ctx.session, true);

            for (const booking of active) await this.releaseCapacity(booking, ctx.session);

            await this.bookings.anonymizeFinishedByUser(userId, ctx.session);
            await this.bookings.deleteMany(
                { user_id: new Types.ObjectId(userId), active: true },
                ctx.session,
            );
            await this.waitlist.deleteByUser(userId, ctx.session);
        });
        this.cascade.register('service', 'bookings.delete', async (serviceId, ctx) => {
            await this.bookings.deleteByService(serviceId, ctx.session);
            await this.waitlist.deleteByService(serviceId, ctx.session);
        });
        this.cascade.register('organization', 'bookings.delete', async (organizationId, ctx) => {
            await this.bookings.deleteByOrganization(organizationId, ctx.session);
            await this.waitlist.deleteByOrganization(organizationId, ctx.session);
        });

        this.outbox.registerHandler('booking.created', 'mail', async (event) => {
            const internal = event.internal ?? {};
            const subscribe = internal['subscribe'];

            if (typeof subscribe !== 'string' || !subscribe) return;

            await this.mail.sendBookingNotification(subscribe, {
                service: text(event.payload['service_label']),
                date: (event.payload['date'] as string | null) ?? undefined,
                time: (event.payload['time'] as string | null) ?? undefined,
                phone: text(internal['phone']),
                name: text(internal['person']),
            });
        });
        this.outbox.registerHandler('booking.reminder', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!email) return;

            await this.mail.sendBookingReminder(email, notice(event));
        });
        this.outbox.registerHandler('booking.reminder', 'sms', async (event) => {
            const { phone, ...data } = notice(event);

            if (recipientEmail(event) || !phone) return;

            await this.sms.send(phone, texts.sms.reminder(data), 'reminder');
        });
        this.outbox.registerHandler('waitlist.slot_available', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!email) return;

            await this.mail.sendWaitlistNotification(email, notice(event));
        });
        this.outbox.registerHandler('waitlist.slot_available', 'sms', async (event) => {
            const { phone, ...data } = notice(event);

            if (recipientEmail(event) || !phone) return;

            await this.sms.send(phone, texts.sms.waitlist(data), 'waitlist');
        });
    }

    async createIdempotent(
        serviceId: string,
        input: CreateBookingInput,
        actor: AuthUser,
        key?: string,
    ): Promise<{ booking: BookingCreated; replayed: boolean }> {
        if (!key) return { booking: await this.create(serviceId, input, actor), replayed: false };

        const outcome = await this.idempotency.run(
            'bookings.create',
            key,
            actor.id,
            { service_id: serviceId, ...input },
            async () => (await this.create(serviceId, input, actor)) as unknown as Record<string, unknown>,
        );

        return { booking: outcome.result as unknown as BookingCreated, replayed: outcome.replayed };
    }

    async create(serviceId: string, input: CreateBookingInput, actor: AuthUser): Promise<BookingCreated> {
        const bookingId = randomUUID();
        const createdAt = new Date();

        return this.tx.run(async (ctx) => {
            const service = await this.loadBookable(serviceId, actor, ctx.session);
            const target = this.resolveTarget(service, input.option_id, input.slot_id, input.time, createdAt);
            this.assertPolicy(service, target, actor, createdAt);
            await this.assertActiveLimit(service, actor, ctx.session);
            const { fields, documents } = this.validateForm(service, input);
            const status: BookingStatus = service.booking_policy?.requires_confirmation
                ? 'pending'
                : 'confirmed';
            const booking: Booking = {
                id: bookingId,
                service_id: service._id,
                organization_id: service.organization_id,
                option_id: target.option.id,
                slot_id: target.slot.id,
                child_type: target.slot.child_type,
                slot_date: target.slot.value.date ?? null,
                slot_time: target.time ?? null,
                service_label: service.value.heading_value ?? service.label,
                user_id: new Types.ObjectId(actor.id),
                person: actor.name ?? '',
                phone: actor.phone ?? '',
                info: input.info ?? '',
                fields,
                documents,
                status,
                active: true,
                confirmed_at: status === 'confirmed' ? createdAt : null,
                finished_at: null,
                status_changed_by: null,
                reminder_sent_at: null,
            };

            await this.insert(booking, ctx.session);
            await this.take(service._id.toHexString(), target, ctx.session);
            await this.waitlist.deleteForUserSlot(
                booking.user_id,
                service._id,
                booking.option_id,
                booking.slot_id,
                booking.slot_time,
                ctx.session,
            );
            await this.emit(ctx, 'booking.created', booking, {
                subscribe: service.value.subscribe,
                person: booking.person,
                phone: booking.phone,
            });

            return {
                booking_id: bookingId,
                service_id: serviceId,
                organization_id: service.organization_id.toHexString(),
                option_id: target.option.id,
                slot_id: target.slot.id,
                child_type: target.slot.child_type,
                status,
                date: target.slot.value.date,
                time: target.time,
                created_at: createdAt.toISOString(),
            };
        });
    }

    list(query: ListBookingsQuery, actor: AuthUser): Promise<PaginatedResult<BookingResource>> {
        const filter: FilterQuery<Booking> = this.organizationScope(query.organization_id, actor);

        if (query.service_id) filter['service_id'] = new Types.ObjectId(query.service_id);

        if (query.user_id) filter['user_id'] = new Types.ObjectId(query.user_id);

        if (query.option_id) filter['option_id'] = query.option_id;

        if (query.slot_id) filter['slot_id'] = query.slot_id;

        if (query.child_type) filter['child_type'] = query.child_type;

        return this.paginate(filter, query);
    }

    listOwn(query: ListOwnBookingsQuery, actor: AuthUser): Promise<PaginatedResult<BookingResource>> {
        return this.paginate({ user_id: new Types.ObjectId(actor.id) }, query);
    }

    listForService(
        serviceId: string,
        query: ListServiceBookingsQuery,
    ): Promise<PaginatedResult<BookingResource>> {
        if (!Types.ObjectId.isValid(serviceId)) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const filter: FilterQuery<Booking> = { service_id: new Types.ObjectId(serviceId) };

        if (query.option_id) filter['option_id'] = query.option_id;

        if (query.slot_id) filter['slot_id'] = query.slot_id;

        return this.paginate(filter, query);
    }

    async getById(bookingId: string, actor: AuthUser): Promise<BookingResource> {
        const booking = await this.bookings.findByPublicId(bookingId);

        if (!booking || !this.mayAccess(booking, actor)) throw ApiError.notFound('BOOKING_NOT_FOUND');

        return toResource(booking);
    }

    async stats(query: BookingStatsQuery, actor: AuthUser): Promise<BookingStats> {
        const filter: FilterQuery<Booking> = this.organizationScope(query.organization_id, actor);

        if (query.service_id) filter['service_id'] = new Types.ObjectId(query.service_id);

        if (query.date_from || query.date_to) {
            filter['slot_date'] = {
                ...(query.date_from ? { $gte: query.date_from } : {}),
                ...(query.date_to ? { $lte: query.date_to } : {}),
            };
        }

        const counts = await this.bookings.countByStatus(filter);
        const outcomes = counts.by_status.completed + counts.by_status.no_show;
        const decided = outcomes + counts.by_status.cancelled;

        return {
            total: counts.total,
            by_status: counts.by_status,
            no_show_rate: outcomes > 0 ? counts.by_status.no_show / outcomes : null,
            cancellation_rate: decided > 0 ? counts.by_status.cancelled / decided : null,
        };
    }

    private async paginate(
        filter: FilterQuery<Booking>,
        query: { page?: number; limit?: number; sort?: string; order?: 'asc' | 'desc' } & DateRange &
            StatusFilter,
    ): Promise<PaginatedResult<BookingResource>> {
        const pagination = this.pagination.resolve(query, {
            sortable: BOOKING_SORTABLE,
            defaultSort: 'created_at',
        });
        const scoped: FilterQuery<Booking> = { ...filter };
        const status = query.status ?? 'active';

        if (status === 'active') scoped['active'] = true;
        else if (status !== 'all') scoped['status'] = status;

        if (query.date_from || query.date_to) {
            scoped['slot_date'] = {
                ...(query.date_from ? { $gte: query.date_from } : {}),
                ...(query.date_to ? { $lte: query.date_to } : {}),
            };
        }

        const result = await this.bookings.list(scoped, pagination);

        return { ...result, items: result.items.map(toResource) };
    }

    private organizationScope(organizationId: string | undefined, actor: AuthUser): FilterQuery<Booking> {
        if (actor.role === ROLES.SUPER_ADMIN) {
            return organizationId ? { organization_id: new Types.ObjectId(organizationId) } : {};
        }

        if (organizationId) {
            if (!actor.organization_ids.includes(organizationId)) throw ApiError.forbidden('FORBIDDEN');

            return { organization_id: new Types.ObjectId(organizationId) };
        }

        return { organization_id: { $in: actor.organization_ids.map((id) => new Types.ObjectId(id)) } };
    }

    cancelById(bookingId: string, actor: AuthUser): Promise<Cancelled> {
        return this.remove(bookingId, actor);
    }

    /** The booking row carries its organization, so neither the owner nor the admin check needs the service. */
    async cancel(serviceId: string, bookingId: string, actor: AuthUser): Promise<Cancelled> {
        return this.remove(bookingId, actor, serviceId);
    }

    private async remove(bookingId: string, actor: AuthUser, serviceId?: string): Promise<Cancelled> {
        return this.tx.run(async (ctx) => {
            const booking = await this.bookings.findByPublicId(bookingId, ctx.session);

            if (!booking || (serviceId !== undefined && booking.service_id.toHexString() !== serviceId))
                throw ApiError.notFound('BOOKING_NOT_FOUND');

            if (!this.mayAccess(booking, actor)) throw ApiError.forbidden('FORBIDDEN');

            if (!booking.active) throw ApiError.unprocessable('BOOKING_NOT_ACTIVE');

            if (!this.isAdminOf(booking, actor)) await this.assertCancelDeadline(booking, ctx.session);

            const cancelled = await this.finish(booking, 'cancelled', actor, ctx);

            return {
                user_id: cancelled.user_id.toHexString(),
                date: cancelled.slot_date ?? undefined,
                time: cancelled.slot_time ?? undefined,
                child_type: cancelled.child_type,
            };
        });
    }

    async setStatus(bookingId: string, status: BookingStatus, actor: AuthUser): Promise<BookingResource> {
        const updated = await this.tx.run(async (ctx) => {
            const booking = await this.bookings.findByPublicId(bookingId, ctx.session);

            if (!booking || !this.isAdminOf(booking, actor)) throw ApiError.notFound('BOOKING_NOT_FOUND');

            if (!TRANSITIONS[booking.status].includes(status))
                throw ApiError.unprocessable('BOOKING_STATUS_TRANSITION', [
                    { path: 'status', message: `Cannot move from ${booking.status} to ${status}` },
                ]);

            if (status === 'cancelled') return this.finish(booking, 'cancelled', actor, ctx);

            const moved = await this.bookings.transition(
                booking.id,
                [booking.status],
                status,
                new Types.ObjectId(actor.id),
                new Date(),
                ctx.session,
            );

            if (!moved) throw ApiError.conflict('CONFLICT');

            await this.emit(ctx, 'booking.status_changed', moved, undefined, {
                previous_status: booking.status,
            });

            return moved;
        });

        return toResource(updated);
    }

    async reschedule(
        bookingId: string,
        input: RescheduleBookingInput,
        actor: AuthUser,
    ): Promise<BookingResource> {
        const moved = await this.tx.run(async (ctx) => {
            const now = new Date();
            const booking = await this.bookings.findByPublicId(bookingId, ctx.session);

            if (!booking) throw ApiError.notFound('BOOKING_NOT_FOUND');

            if (!this.mayAccess(booking, actor)) throw ApiError.forbidden('FORBIDDEN');

            if (!booking.active) throw ApiError.unprocessable('BOOKING_NOT_ACTIVE');

            const admin = this.isAdminOf(booking, actor);
            const service = await this.loadBookable(booking.service_id.toHexString(), actor, ctx.session);

            if (!admin) this.assertDeadline(service, booking, now);

            const target = this.resolveTarget(
                service,
                input.option_id ?? booking.option_id,
                input.slot_id,
                input.time,
                now,
            );

            if (
                target.option.id === booking.option_id &&
                target.slot.id === booking.slot_id &&
                (target.time ?? null) === booking.slot_time
            )
                throw ApiError.conflict('BOOKING_ALREADY_EXISTS');

            if (!admin) this.assertPolicy(service, target, actor, now);

            await this.releaseCapacity(booking, ctx.session);
            await this.take(service._id.toHexString(), target, ctx.session);
            let updated: BookingEntity | null;
            try {
                updated = await this.bookings.move(
                    booking.id,
                    {
                        option_id: target.option.id,
                        slot_id: target.slot.id,
                        child_type: target.slot.child_type,
                        slot_date: target.slot.value.date ?? null,
                        slot_time: target.time ?? null,
                    },
                    ctx.session,
                );
            } catch (error) {
                if ((error as { code?: number }).code === DUPLICATE_KEY)
                    throw ApiError.conflict('BOOKING_ALREADY_EXISTS');

                throw error;
            }

            if (!updated) throw ApiError.notFound('BOOKING_NOT_FOUND');

            await this.notifyWaitlist(booking, ctx);
            await this.emit(ctx, 'booking.rescheduled', updated, undefined, {
                previous: {
                    option_id: booking.option_id,
                    slot_id: booking.slot_id,
                    date: booking.slot_date,
                    time: booking.slot_time,
                },
            });

            return updated;
        });

        return toResource(moved);
    }

    private async finish(
        booking: BookingEntity,
        status: 'cancelled',
        actor: AuthUser,
        ctx: TransactionContext,
    ): Promise<BookingEntity> {
        const moved = await this.bookings.transition(
            booking.id,
            [...ACTIVE_BOOKING_STATUSES],
            status,
            new Types.ObjectId(actor.id),
            new Date(),
            ctx.session,
        );

        if (!moved) throw ApiError.unprocessable('BOOKING_NOT_ACTIVE');

        await this.releaseCapacity(booking, ctx.session);
        await this.notifyWaitlist(booking, ctx);
        await this.emit(ctx, 'booking.cancelled', moved, undefined, {
            cancelled_by: actor.id === booking.user_id.toHexString() ? 'owner' : 'admin',
        });

        return moved;
    }

    async joinWaitlist(
        serviceId: string,
        input: JoinWaitlistInput,
        actor: AuthUser,
    ): Promise<WaitlistEntryResource> {
        const entry = await this.tx.run(async (ctx) => {
            const now = new Date();
            const service = await this.loadBookable(serviceId, actor, ctx.session);
            const target = this.resolveTarget(service, input.option_id, input.slot_id, input.time, now);
            const booked =
                target.time === undefined
                    ? (target.slot.value.booked_count ?? 0)
                    : this.timeEntry(target).booked_count;

            if (target.limit === null || booked < target.limit) throw ApiError.unprocessable('SLOT_NOT_FULL');

            const row: WaitlistEntry = {
                id: randomUUID(),
                service_id: service._id,
                organization_id: service.organization_id,
                option_id: target.option.id,
                slot_id: target.slot.id,
                slot_date: target.slot.value.date ?? null,
                slot_time: target.time ?? null,
                service_label: service.value.heading_value ?? service.label,
                user_id: new Types.ObjectId(actor.id),
                person: actor.name ?? '',
                phone: actor.phone ?? '',
                status: 'waiting',
                notified_at: null,
            };
            try {
                return await this.waitlist.create(row, ctx.session);
            } catch (error) {
                if ((error as { code?: number }).code === DUPLICATE_KEY)
                    throw ApiError.conflict('WAITLIST_ALREADY_JOINED');

                throw error;
            }
        });

        return toWaitlistResource(entry);
    }

    async listOwnWaitlist(
        query: ListWaitlistQuery,
        actor: AuthUser,
    ): Promise<PaginatedResult<WaitlistEntryResource>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at'],
            defaultSort: 'created_at',
        });
        const result = await this.waitlist.listByUser(actor.id, pagination);

        return { ...result, items: result.items.map(toWaitlistResource) };
    }

    async listWaitlistForService(
        serviceId: string,
        query: ListWaitlistQuery,
    ): Promise<PaginatedResult<WaitlistEntryResource>> {
        if (!Types.ObjectId.isValid(serviceId)) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at'],
            defaultSort: 'created_at',
            defaultOrder: 'asc',
        });
        const filter: FilterQuery<WaitlistEntry> = { service_id: new Types.ObjectId(serviceId) };

        if (query.option_id) filter['option_id'] = query.option_id;

        if (query.slot_id) filter['slot_id'] = query.slot_id;

        const result = await this.waitlist.list(filter, pagination);

        return { ...result, items: result.items.map(toWaitlistResource) };
    }

    async leaveWaitlist(id: string, actor: AuthUser): Promise<void> {
        const entry = await this.waitlist.findByPublicId(id);

        if (!entry || !this.mayAccess(entry, actor)) throw ApiError.notFound('WAITLIST_NOT_FOUND');

        await this.waitlist.deleteByPublicId(id);
    }

    async notifyWaitlist(booking: BookingEntity, ctx: TransactionContext): Promise<void> {
        const entry = await this.waitlist.claimNextWaiting(
            booking.service_id,
            booking.option_id,
            booking.slot_id,
            booking.slot_time,
            new Date(),
            ctx.session,
        );

        if (!entry) return;

        const user = await this.users.findById(entry.user_id.toHexString());

        await this.outbox.enqueue(
            'waitlist.slot_available',
            {
                waitlist_id: entry.id,
                service_id: entry.service_id.toHexString(),
                organization_id: entry.organization_id.toHexString(),
                option_id: entry.option_id,
                slot_id: entry.slot_id,
                date: entry.slot_date,
                time: entry.slot_time,
                user_id: entry.user_id.toHexString(),
                service_label: entry.service_label,
            },
            {
                organizationId: entry.organization_id,
                internal: { phone: entry.phone, email: user?.email ?? null },
                session: ctx.session,
            },
        );
    }

    private async loadBookable(
        serviceId: string,
        actor: AuthUser,
        session: ClientSession,
    ): Promise<ServiceEntity> {
        const service = await this.repository.findById(serviceId, session);

        if (!service || service.deleted_at) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const privileged = this.masker.canSeeDetails(actor, service.organization_id.toHexString());

        if (privileged) return service;

        if (service.status !== 'published') throw ApiError.unprocessable('SERVICE_NOT_PUBLISHED');

        const organization = await this.organizations.getById(service.organization_id.toHexString());

        const closedUntil = organization.closed_until?.getTime();
        const stillClosed = closedUntil === undefined || closedUntil === null || closedUntil > Date.now();

        if (organization.status === 'temporarily_closed' && stillClosed)
            throw ApiError.unprocessable('ORGANIZATION_CLOSED');

        return service;
    }

    private resolveTarget(
        service: ServiceEntity,
        optionId: string,
        slotId: string,
        time: string | undefined,
        now: Date,
    ): Target {
        const option = service.options.find((item) => item.id === optionId);
        const slot = option?.slots.find((item) => item.id === slotId);

        if (!option || !slot) throw ApiError.notFound('SLOT_NOT_FOUND');

        if (!option.enabled) throw ApiError.unprocessable('OPTION_DISABLED');

        if (!BOOKABLE_SLOT_TYPES.includes(slot.child_type)) throw ApiError.unprocessable('SLOT_NOT_BOOKABLE');

        if (typeof slot.value.date === 'string' && slot.value.date < formatDateOnly(now))
            throw ApiError.unprocessable('SLOT_EXPIRED');

        if (slot.child_type === 'date_time') {
            if (!time) throw ApiError.unprocessable('SLOT_TIME_REQUIRED');

            const entry = (slot.value.time ?? []).find((item) => item.time === time);

            if (!entry) throw ApiError.notFound('SLOT_NOT_FOUND');

            return { option, slot, time: entry.time, limit: entry.limit };
        }

        return { option, slot, time: undefined, limit: slot.value.limit ?? null };
    }

    private timeEntry(target: Target): { booked_count: number } {
        return (
            (target.slot.value.time ?? []).find((item) => item.time === target.time) ?? { booked_count: 0 }
        );
    }

    private assertPolicy(service: ServiceEntity, target: Target, actor: AuthUser, now: Date): void {
        if (this.masker.canSeeDetails(actor, service.organization_id.toHexString())) return;

        const policy = service.booking_policy;
        const start = slotStart(target.slot.value.date, target.time);

        if (!policy || !start) return;

        if (policy.lead_time_minutes !== null && policy.lead_time_minutes !== undefined) {
            if (start.getTime() - now.getTime() < policy.lead_time_minutes * 60_000)
                throw ApiError.unprocessable('BOOKING_LEAD_TIME');
        }

        if (policy.max_advance_days !== null && policy.max_advance_days !== undefined) {
            const horizon = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() + policy.max_advance_days,
                23,
                59,
            );

            if (start.getTime() > horizon.getTime()) throw ApiError.unprocessable('BOOKING_TOO_FAR_AHEAD');
        }
    }

    private async assertActiveLimit(
        service: ServiceEntity,
        actor: AuthUser,
        session: ClientSession,
    ): Promise<void> {
        const max = service.booking_policy?.max_active_per_user;

        if (max === null || max === undefined) return;

        const active = await this.bookings.countActiveByUserAndService(
            actor.id,
            service._id.toHexString(),
            session,
        );

        if (active >= max) throw ApiError.unprocessable('BOOKING_LIMIT_REACHED');
    }

    private async assertCancelDeadline(booking: BookingEntity, session: ClientSession): Promise<void> {
        const service = await this.repository.findById(booking.service_id.toHexString(), session);

        if (!service) return;

        this.assertDeadline(service, booking, new Date());
    }

    private assertDeadline(service: ServiceEntity, booking: BookingEntity, now: Date): void {
        const deadline = service.booking_policy?.cancel_deadline_minutes;
        const start = slotStart(booking.slot_date, booking.slot_time);

        if (deadline === null || deadline === undefined || !start) return;

        if (start.getTime() - now.getTime() < deadline * 60_000)
            throw ApiError.unprocessable('BOOKING_CANCEL_DEADLINE_PASSED');
    }

    private validateForm(
        service: ServiceEntity,
        input: CreateBookingInput,
    ): { fields: Record<string, unknown>; documents: string[] } {
        const form = validateBookingFields(service.form_fields ?? [], input.fields ?? {});

        if (form.details.length > 0) throw ApiError.unprocessable('BOOKING_FIELDS_INVALID', form.details);

        const documents = input.documents ?? [];
        const missing: ApiErrorDetail[] = validateDocuments(service.required_documents ?? [], documents);

        if (missing.length > 0) throw ApiError.unprocessable('BOOKING_DOCUMENTS_REQUIRED', missing);

        return { fields: form.values, documents: [...new Set(documents)] };
    }

    private mayAccess(
        row: { user_id: Types.ObjectId; organization_id: Types.ObjectId },
        actor: AuthUser,
    ): boolean {
        return row.user_id.toHexString() === actor.id || this.isAdminOf(row, actor);
    }

    private isAdminOf(row: { organization_id: Types.ObjectId }, actor: AuthUser): boolean {
        return this.masker.canSeeDetails(actor, row.organization_id.toHexString());
    }

    private async insert(booking: Booking, session: ClientSession): Promise<void> {
        try {
            await this.bookings.create(booking, session);
        } catch (error) {
            if ((error as { code?: number }).code === DUPLICATE_KEY)
                throw ApiError.conflict('BOOKING_ALREADY_EXISTS');

            throw error;
        }
    }

    private async take(serviceId: string, target: Target, session: ClientSession): Promise<void> {
        const accepted =
            target.time === undefined
                ? await this.repository.incrementSlotCount(
                      serviceId,
                      target.option.id,
                      target.slot.id,
                      target.limit,
                      session,
                  )
                : await this.repository.incrementTimeCount(
                      serviceId,
                      target.option.id,
                      target.slot.id,
                      target.time,
                      target.limit,
                      session,
                  );

        if (!accepted) throw ApiError.unprocessable('SLOT_FULL');
    }

    private async emit(
        ctx: TransactionContext,
        type: 'booking.created' | 'booking.cancelled' | 'booking.rescheduled' | 'booking.status_changed',
        booking: BookingEntity | Booking,
        internal?: Record<string, unknown>,
        extra: Record<string, unknown> = {},
    ): Promise<void> {
        await this.outbox.enqueue(type, eventPayload(booking, extra), {
            organizationId: booking.organization_id,
            internal,
            session: ctx.session,
        });
        ctx.afterCommit(() => this.outbox.poke());
    }

    private async releaseCapacity(booking: BookingEntity, session?: ClientSession): Promise<void> {
        const serviceId = booking.service_id.toHexString();

        if (booking.slot_time) {
            await this.repository.decrementTimeCount(
                serviceId,
                booking.option_id,
                booking.slot_id,
                booking.slot_time,
                session,
            );

            return;
        }

        await this.repository.decrementSlotCount(serviceId, booking.option_id, booking.slot_id, session);
    }
}
