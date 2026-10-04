import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type ClientSession, type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { AppConfig } from '../../common/config/app-config';
import { type TransactionContext, TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ApiError, type ApiErrorDetail } from '../../common/http/api-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { dateOnlyIn, instantIn, shiftDateOnly } from '../../common/time/zone';
import { MailService } from '../../integrations/mail/mail.service';
import { type BookingEntity, BookingsRepository } from '../bookings/bookings.repository';
import {
    type BookingResource,
    type BookingStats,
    type BookingStatsQuery,
    type ExportBookingsQuery,
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
import { type SlotBody } from '../slots/schemas/slot.schema';
import { ChannelTemplatesService } from '../channel-templates/channel-templates.service';
import { SlotsRepository } from '../slots/slots.repository';
import { SmsService } from '../sms/sms.service';
import { UsersService } from '../users/users.service';
import { BookingCalendarService } from './booking-calendar.service';
import { eventActor, eventPayload, notice, organizationOf, recipientEmail, text } from './booking-events';
import { validateBookingFields, validateDocuments } from './booking-form';
import { type BookingCreated, type CreateBookingInput } from './dto/service.schemas';
import {
    ADDRESS_SERVICE_TYPES,
    BOOKABLE_SLOT_TYPES,
    type ServiceOption,
    TIMED_SLOT_TYPES,
} from './schemas/service.schema';
import { ServicesMasker } from './services.masker';
import { type ServiceEntity, ServicesRepository } from './services.repository';
import { assertFitsRange, minutesOf, rangeOf, timeOf } from './slot.logic';
import { SuspensionsService } from './suspensions.service';

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
    slot: SlotBody;
    time: string | undefined;
    end: string | undefined;
    limit: number | null;
}

interface Bookable {
    service: ServiceEntity;
    timeZone: string;
}

interface Booker {
    id: Types.ObjectId;
    name: string;
    phone: string;
}

interface Cancelled {
    user_id: string;
    date?: string;
    time?: string;
    child_type: string;
}

function toResource(booking: BookingEntity, cancelDeadlineMinutes?: number | null): BookingResource {
    const startsAt = booking.starts_at ?? null;
    const deadline =
        startsAt && cancelDeadlineMinutes !== null && cancelDeadlineMinutes !== undefined
            ? new Date(startsAt.getTime() - cancelDeadlineMinutes * 60_000)
            : null;

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
        end_time: booking.slot_end ?? null,
        starts_at: startsAt ? startsAt.toISOString() : null,
        ends_at: booking.ends_at ? booking.ends_at.toISOString() : null,
        cancel_deadline_at: deadline ? deadline.toISOString() : null,
        user_id: booking.user_id.toHexString(),
        person: booking.person,
        phone: booking.phone,
        info: booking.info,
        address: booking.address ?? null,
        fields: booking.fields ?? {},
        documents: booking.documents ?? [],
        status: booking.status,
        confirmed_at: booking.confirmed_at ? booking.confirmed_at.toISOString() : null,
        finished_at: booking.finished_at ? booking.finished_at.toISOString() : null,
        late_cancel: booking.late_cancel ?? false,
        created_by: booking.created_by ? booking.created_by.toHexString() : null,
        created_at: booking.created_at.toISOString(),
    };
}

function scoped(filter: FilterQuery<Booking>, query: DateRange & StatusFilter): FilterQuery<Booking> {
    const result: FilterQuery<Booking> = { ...filter };
    const status = query.status ?? 'active';

    if (status === 'active') result['active'] = true;
    else if (status !== 'all') result['status'] = status;

    if (query.date_from || query.date_to) {
        result['slot_date'] = {
            ...(query.date_from ? { $gte: query.date_from } : {}),
            ...(query.date_to ? { $lte: query.date_to } : {}),
        };
    }

    return result;
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

function slotStart(
    date: string | null | undefined,
    time: string | null | undefined,
    timeZone: string,
    timeRequired = false,
): Date | null {
    return date && (time || !timeRequired) ? instantIn(date, time, timeZone) : null;
}

@Injectable()
export class BookingsService implements OnModuleInit {
    constructor(
        private readonly repository: ServicesRepository,
        private readonly slots: SlotsRepository,
        private readonly bookings: BookingsRepository,
        private readonly waitlist: WaitlistRepository,
        private readonly organizations: OrganizationsService,
        private readonly users: UsersService,
        private readonly mail: MailService,
        private readonly sms: SmsService,
        private readonly templates: ChannelTemplatesService,
        private readonly outbox: OutboxService,
        private readonly masker: ServicesMasker,
        private readonly calendar: BookingCalendarService,
        private readonly suspensions: SuspensionsService,
        private readonly pagination: PaginationService,
        private readonly idempotency: IdempotencyService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly config: AppConfig,
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

            const message = await this.templates.mail(organizationOf(event), 'booking_created_mail', {
                ...notice(event),
                phone: text(internal['phone']),
                name: text(internal['person']),
            });
            await this.mail.send({ to: [subscribe], ...message });
        });
        this.outbox.registerHandler('booking.reminder', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!email) return;

            const calendar = await this.calendar.attachment(text(event.payload['booking_id']));
            const message = await this.templates.mail(organizationOf(event), 'booking_reminder_mail', {
                ...notice(event),
                calendar: Boolean(calendar),
            });
            await this.mail.send({
                to: [email],
                ...message,
                ...(calendar ? { attachments: [calendar] } : {}),
            });
        });
        this.outbox.registerHandler('booking.reminder', 'sms', async (event) => {
            const { phone, ...data } = notice(event);

            if (recipientEmail(event) || !phone) return;

            await this.sms.send(
                phone,
                await this.templates.sms(organizationOf(event), 'booking_reminder_sms', data),
                'reminder',
            );
        });
        this.outbox.registerHandler('booking.callback_due', 'mail', async (event) => {
            const service = await this.repository.findById(text(event.payload['service_id']));
            const subscribe = service?.value.subscribe;

            if (!subscribe) return;

            const message = await this.templates.mail(organizationOf(event), 'callback_due_mail', {
                ...notice(event),
                phone: text(event.internal?.['phone']),
                name: text(event.internal?.['person']),
            });
            await this.mail.send({ to: [subscribe], ...message });
        });
        this.outbox.registerHandler('waitlist.slot_available', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!email) return;

            const message = await this.templates.mail(
                organizationOf(event),
                'waitlist_available_mail',
                notice(event),
            );
            await this.mail.send({ to: [email], ...message });
        });
        this.outbox.registerHandler('waitlist.slot_available', 'sms', async (event) => {
            const { phone, ...data } = notice(event);

            if (recipientEmail(event) || !phone) return;

            await this.sms.send(
                phone,
                await this.templates.sms(organizationOf(event), 'waitlist_available_sms', data),
                'waitlist',
            );
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
        if (input.on_behalf && actor.role === ROLES.COMMON_USER) throw ApiError.forbidden('FORBIDDEN');

        const bookingId = randomUUID();
        const createdAt = new Date();

        return this.tx.run(async (ctx) => {
            const bookable = await this.loadBookable(serviceId, actor, ctx.session);
            const { service, timeZone } = bookable;

            if (input.on_behalf && !this.isAdminOf(service, actor)) throw ApiError.forbidden('FORBIDDEN');

            const target = await this.resolveTarget(
                bookable,
                input.option_id,
                input.slot_id,
                input.time,
                input.end_time,
                createdAt,
                ctx.session,
            );
            const booker = await this.bookerOf(input, actor, ctx.session);
            const address = this.addressFor(target, input.address);

            if (target.slot.child_type === 'callback' && !booker.phone)
                throw ApiError.unprocessable('BOOKING_PHONE_REQUIRED');

            if (!input.on_behalf) {
                await this.suspensions.assertNotSuspended(
                    actor.id,
                    service._id.toHexString(),
                    createdAt,
                    ctx.session,
                );
                this.assertPolicy(bookable, target, actor, createdAt);
                await this.assertActiveLimit(service, actor, ctx.session);
            }

            const { fields, documents } = this.validateForm(service, input);
            const status: BookingStatus =
                !input.on_behalf && service.booking_policy?.requires_confirmation ? 'pending' : 'confirmed';
            const booking: Booking = {
                id: bookingId,
                service_id: service._id,
                organization_id: service.organization_id,
                option_id: target.option.id,
                slot_id: target.slot.id,
                child_type: target.slot.child_type,
                slot_date: target.slot.value.date ?? null,
                slot_time: target.time ?? null,
                slot_end: target.end ?? null,
                starts_at: slotStart(target.slot.value.date, target.time, timeZone),
                ends_at: slotStart(target.slot.value.date, target.end, timeZone, true),
                service_label: service.value.heading_value ?? service.label,
                user_id: booker.id,
                person: booker.name,
                phone: booker.phone,
                info: input.info ?? '',
                address,
                fields,
                documents,
                status,
                active: true,
                confirmed_at: status === 'confirmed' ? createdAt : null,
                finished_at: null,
                status_changed_by: null,
                created_by: new Types.ObjectId(actor.id),
                reminder_sent_at: null,
            };

            await this.insert(booking, ctx.session);
            await this.take(service, target, bookingId, ctx.session);
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
                actor: { id: actor.id, kind: input.on_behalf ? 'staff' : 'client' },
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
                end_time: target.end,
                user_id: booker.id.toHexString(),
                created_at: createdAt.toISOString(),
            };
        });
    }

    private async bookerOf(
        input: CreateBookingInput,
        actor: AuthUser,
        session: ClientSession,
    ): Promise<Booker> {
        if (!input.on_behalf) {
            return { id: new Types.ObjectId(actor.id), name: actor.name ?? '', phone: actor.phone ?? '' };
        }

        const client = await this.users.findOrCreateClient(input.on_behalf, session);

        return { id: client._id, name: input.on_behalf.name, phone: client.phone ?? input.on_behalf.phone };
    }

    list(query: ListBookingsQuery, actor: AuthUser): Promise<PaginatedResult<BookingResource>> {
        return this.paginate(this.filterOf(query, actor), query);
    }

    export(query: ExportBookingsQuery, actor: AuthUser): AsyncIterable<BookingEntity> {
        return this.bookings.iterate(scoped(this.filterOf(query, actor), query));
    }

    private filterOf(query: ExportBookingsQuery, actor: AuthUser): FilterQuery<Booking> {
        const filter: FilterQuery<Booking> = this.organizationScope(query.organization_id, actor);

        if (query.service_id) filter['service_id'] = new Types.ObjectId(query.service_id);

        if (query.user_id) filter['user_id'] = new Types.ObjectId(query.user_id);

        if (query.option_id) filter['option_id'] = query.option_id;

        if (query.slot_id) filter['slot_id'] = query.slot_id;

        if (query.child_type) filter['child_type'] = query.child_type;

        return filter;
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

        return this.asResource(booking);
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
        const result = await this.bookings.list(scoped(filter, query), pagination);
        const deadlines = await this.repository.cancelDeadlines([
            ...new Set(result.items.map((booking) => booking.service_id.toHexString())),
        ]);

        return {
            ...result,
            items: result.items.map((booking) =>
                toResource(booking, deadlines.get(booking.service_id.toHexString()) ?? null),
            ),
        };
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

            const late = !this.isAdminOf(booking, actor) && (await this.isLateCancel(booking, ctx.session));
            const cancelled = await this.finish(booking, 'cancelled', actor, ctx, late);

            if (late) await this.suspensions.onLateCancel(cancelled, ctx);

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

            await this.emit(ctx, 'booking.status_changed', moved, this.trail(booking, actor), {
                previous_status: booking.status,
            });
            await this.suspensions.onStatusChanged(moved, booking.status, actor, ctx);

            return moved;
        });

        return this.asResource(updated);
    }

    async confirm(bookingId: string, actor: AuthUser): Promise<BookingResource> {
        const confirmed = await this.tx.run(async (ctx) => {
            const booking = await this.bookings.findByPublicId(bookingId, ctx.session);

            if (!booking || !this.mayAccess(booking, actor)) throw ApiError.notFound('BOOKING_NOT_FOUND');

            if (booking.status !== 'pending')
                throw ApiError.unprocessable('BOOKING_STATUS_TRANSITION', [
                    { path: 'status', message: `Cannot move from ${booking.status} to confirmed` },
                ]);

            const moved = await this.bookings.transition(
                booking.id,
                ['pending'],
                'confirmed',
                new Types.ObjectId(actor.id),
                new Date(),
                ctx.session,
            );

            if (!moved) throw ApiError.conflict('CONFLICT');

            await this.emit(ctx, 'booking.status_changed', moved, this.trail(booking, actor), {
                previous_status: booking.status,
            });

            return moved;
        });

        return this.asResource(confirmed);
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
            const bookable = await this.loadBookable(booking.service_id.toHexString(), actor, ctx.session);
            const { service, timeZone } = bookable;

            if (!admin) this.assertDeadline(service, booking, now);

            const target = await this.resolveTarget(
                bookable,
                input.option_id ?? booking.option_id,
                input.slot_id,
                input.time,
                input.end_time,
                now,
                ctx.session,
            );

            if (
                target.option.id === booking.option_id &&
                target.slot.id === booking.slot_id &&
                (target.time ?? null) === booking.slot_time &&
                (target.end ?? null) === (booking.slot_end ?? null)
            )
                throw ApiError.conflict('BOOKING_ALREADY_EXISTS');

            if (!admin) this.assertPolicy(bookable, target, actor, now);

            const address = this.addressFor(target, input.address ?? booking.address ?? undefined);

            await this.releaseCapacity(booking, ctx.session);
            await this.take(service, target, booking.id, ctx.session);
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
                        slot_end: target.end ?? null,
                        starts_at: slotStart(target.slot.value.date, target.time, timeZone),
                        ends_at: slotStart(target.slot.value.date, target.end, timeZone, true),
                        address,
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
            await this.emit(ctx, 'booking.rescheduled', updated, this.trail(booking, actor), {
                previous: {
                    option_id: booking.option_id,
                    slot_id: booking.slot_id,
                    date: booking.slot_date,
                    time: booking.slot_time,
                    end_time: booking.slot_end ?? null,
                },
            });

            return updated;
        });

        return this.asResource(moved);
    }

    private async asResource(booking: BookingEntity): Promise<BookingResource> {
        const deadlines = await this.repository.cancelDeadlines([booking.service_id.toHexString()]);

        return toResource(booking, deadlines.get(booking.service_id.toHexString()) ?? null);
    }

    private async finish(
        booking: BookingEntity,
        status: 'cancelled',
        actor: AuthUser,
        ctx: TransactionContext,
        late = false,
    ): Promise<BookingEntity> {
        const moved = await this.bookings.transition(
            booking.id,
            [...ACTIVE_BOOKING_STATUSES],
            status,
            new Types.ObjectId(actor.id),
            new Date(),
            ctx.session,
            late ? { late_cancel: true } : {},
        );

        if (!moved) throw ApiError.unprocessable('BOOKING_NOT_ACTIVE');

        await this.releaseCapacity(booking, ctx.session);
        await this.notifyWaitlist(booking, ctx);
        await this.emit(ctx, 'booking.cancelled', moved, this.trail(booking, actor), {
            cancelled_by: actor.id === booking.user_id.toHexString() ? 'owner' : 'admin',
            previous_status: booking.status,
            ...(late ? { late_cancel: true } : {}),
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
            const bookable = await this.loadBookable(serviceId, actor, ctx.session);
            const { service } = bookable;

            await this.suspensions.assertNotSuspended(actor.id, serviceId, now, ctx.session);

            const slot = await this.slots.findSlot(serviceId, input.option_id, input.slot_id, ctx.session);

            if (slot?.child_type === 'time_range') throw ApiError.unprocessable('WAITLIST_NOT_SUPPORTED');

            const target = await this.resolveTarget(
                bookable,
                input.option_id,
                input.slot_id,
                input.time,
                undefined,
                now,
                ctx.session,
            );
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
    ): Promise<Bookable> {
        const service = await this.repository.findById(serviceId, session);

        if (!service || service.deleted_at) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const organization = await this.organizations.getById(service.organization_id.toHexString());
        const timeZone = organization.timezone ?? this.config.jobs.timezone;

        if (this.masker.canSeeDetails(actor, service.organization_id.toHexString()))
            return { service, timeZone };

        if (service.status !== 'published') throw ApiError.unprocessable('SERVICE_NOT_PUBLISHED');

        const closedUntil = organization.closed_until?.getTime();
        const stillClosed = closedUntil === undefined || closedUntil === null || closedUntil > Date.now();

        if (organization.status === 'temporarily_closed' && stillClosed)
            throw ApiError.unprocessable('ORGANIZATION_CLOSED');

        return { service, timeZone };
    }

    private async resolveTarget(
        { service, timeZone }: Bookable,
        optionId: string,
        slotId: string,
        time: string | undefined,
        end: string | undefined,
        now: Date,
        session: ClientSession,
    ): Promise<Target> {
        const option = service.options.find((item) => item.id === optionId);
        const slot = option
            ? await this.slots.findSlot(service._id.toHexString(), optionId, slotId, session)
            : null;

        if (!option || !slot) throw ApiError.notFound('SLOT_NOT_FOUND');

        if (!option.enabled) throw ApiError.unprocessable('OPTION_DISABLED');

        if (!BOOKABLE_SLOT_TYPES.includes(slot.child_type)) throw ApiError.unprocessable('SLOT_NOT_BOOKABLE');

        if (typeof slot.value.date === 'string' && slot.value.date < dateOnlyIn(now, timeZone))
            throw ApiError.unprocessable('SLOT_EXPIRED');

        if (slot.child_type === 'time_range') {
            if (!time || !end) throw ApiError.unprocessable('SLOT_TIME_REQUIRED');

            assertFitsRange(rangeOf(slot), { from: time, to: end });

            return { option, slot, time, end, limit: null };
        }

        if (TIMED_SLOT_TYPES.includes(slot.child_type)) {
            if (!time) throw ApiError.unprocessable('SLOT_TIME_REQUIRED');

            const entry = (slot.value.time ?? []).find((item) => item.time === time);

            if (!entry) throw ApiError.notFound('SLOT_NOT_FOUND');

            return { option, slot, time: entry.time, end: entry.to, limit: entry.limit };
        }

        return { option, slot, time: undefined, end: undefined, limit: slot.value.limit ?? null };
    }

    private addressFor(target: Target, address: string | undefined): string | null {
        if (!ADDRESS_SERVICE_TYPES.includes(target.option.service_type)) return null;

        if (!address) throw ApiError.unprocessable('BOOKING_ADDRESS_REQUIRED');

        return address;
    }

    private timeEntry(target: Target): { booked_count: number } {
        return (
            (target.slot.value.time ?? []).find((item) => item.time === target.time) ?? { booked_count: 0 }
        );
    }

    private assertPolicy({ service, timeZone }: Bookable, target: Target, actor: AuthUser, now: Date): void {
        if (this.masker.canSeeDetails(actor, service.organization_id.toHexString())) return;

        const policy = service.booking_policy;
        const start = slotStart(target.slot.value.date, target.time, timeZone);

        if (!policy || !start) return;

        if (policy.lead_time_minutes !== null && policy.lead_time_minutes !== undefined) {
            if (start.getTime() - now.getTime() < policy.lead_time_minutes * 60_000)
                throw ApiError.unprocessable('BOOKING_LEAD_TIME');
        }

        if (policy.max_advance_days !== null && policy.max_advance_days !== undefined) {
            const last = shiftDateOnly(dateOnlyIn(now, timeZone), policy.max_advance_days);
            const horizon = instantIn(last, '23:59', timeZone);

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

    private async isLateCancel(booking: BookingEntity, session: ClientSession): Promise<boolean> {
        const service = await this.repository.findById(booking.service_id.toHexString(), session);

        const now = new Date();

        if (!service || !this.deadlinePassed(service, booking, now)) return false;

        const upcoming = booking.starts_at !== null && booking.starts_at.getTime() > now.getTime();

        if (upcoming && service.booking_policy?.late_cancel === 'no_show') return true;

        throw ApiError.unprocessable('BOOKING_CANCEL_DEADLINE_PASSED');
    }

    private assertDeadline(service: ServiceEntity, booking: BookingEntity, now: Date): void {
        if (this.deadlinePassed(service, booking, now))
            throw ApiError.unprocessable('BOOKING_CANCEL_DEADLINE_PASSED');
    }

    private deadlinePassed(service: ServiceEntity, booking: BookingEntity, now: Date): boolean {
        const deadline = service.booking_policy?.cancel_deadline_minutes;
        const start = booking.starts_at;

        if (deadline === null || deadline === undefined || !start) return false;

        return start.getTime() - now.getTime() < deadline * 60_000;
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

    private async take(
        service: ServiceEntity,
        target: Target,
        bookingId: string,
        session: ClientSession,
    ): Promise<void> {
        const serviceId = service._id.toHexString();

        if (target.slot.child_type === 'time_range') {
            const buffer = service.buffer_minutes ?? 0;
            const from = timeOf(Math.max(0, minutesOf(target.time!) - buffer));
            const to = timeOf(Math.min(24 * 60, minutesOf(target.end!) + buffer));
            const held = await this.slots.incrementSlotCount(
                serviceId,
                target.option.id,
                target.slot.id,
                null,
                session,
            );

            if (!held) throw ApiError.notFound('SLOT_NOT_FOUND');

            const clash = await this.bookings.findOverlapping(
                serviceId,
                target.option.id,
                target.slot.id,
                from,
                to,
                bookingId,
                session,
            );

            if (clash) throw ApiError.unprocessable('SLOT_FULL');

            return;
        }

        const accepted =
            target.time === undefined
                ? await this.slots.incrementSlotCount(
                      serviceId,
                      target.option.id,
                      target.slot.id,
                      target.limit,
                      session,
                  )
                : await this.slots.incrementTimeCount(
                      serviceId,
                      target.option.id,
                      target.slot.id,
                      target.time,
                      target.limit,
                      session,
                  );

        if (!accepted) throw ApiError.unprocessable('SLOT_FULL');
    }

    private trail(booking: BookingEntity, actor: AuthUser): Record<string, unknown> {
        return { actor: eventActor(actor, booking), person: booking.person, phone: booking.phone };
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

        if (booking.slot_time && booking.child_type !== 'time_range') {
            await this.slots.decrementTimeCount(
                serviceId,
                booking.option_id,
                booking.slot_id,
                booking.slot_time,
                session,
            );

            return;
        }

        await this.slots.decrementSlotCount(serviceId, booking.option_id, booking.slot_id, session);
    }
}
