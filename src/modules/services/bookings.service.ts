import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type ClientSession, type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { MailService } from '../../integrations/mail/mail.service';
import { type BookingEntity, BookingsRepository } from '../bookings/bookings.repository';
import {
    type BookingResource,
    type ListBookingsQuery,
    type ListOwnBookingsQuery,
    type ListServiceBookingsQuery,
} from '../bookings/dto/booking.schemas';
import { type Booking } from '../bookings/schemas/booking.schema';
import { type BookingCreated, type CreateBookingInput } from './dto/service.schemas';
import { BOOKABLE_SLOT_TYPES } from './schemas/service.schema';
import { ServicesMasker } from './services.masker';
import { ServicesRepository } from './services.repository';
import { formatDateOnly } from './slot.logic';

const DUPLICATE_KEY = 11000;
const BOOKING_SORTABLE = ['created_at', 'slot_date'] as const;

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
        created_at: booking.created_at.toISOString(),
    };
}

/**
 * Booking creation and cancellation. The booking row and the slot's occupancy counter change in one
 * transaction: the counter is what enforces capacity (a conditional `$inc`), the unique index on the
 * booking row is what refuses duplicates, and the notification e-mail is sent only after the commit.
 */
@Injectable()
export class BookingsService implements OnModuleInit {
    constructor(
        private readonly repository: ServicesRepository,
        private readonly bookings: BookingsRepository,
        private readonly mail: MailService,
        private readonly masker: ServicesMasker,
        private readonly pagination: PaginationService,
        private readonly idempotency: IdempotencyService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('user', 'bookings.delete', async (userId, ctx) => {
            const bookings = await this.bookings.findByUser(userId, ctx.session);

            for (const booking of bookings) await this.releaseCapacity(booking, ctx.session);

            await this.bookings.deleteByUser(userId, ctx.session);
        });
        this.cascade.register('service', 'bookings.delete', async (serviceId, ctx) => {
            await this.bookings.deleteByService(serviceId, ctx.session);
        });
        this.cascade.register('organization', 'bookings.delete', async (organizationId, ctx) => {
            await this.bookings.deleteByOrganization(organizationId, ctx.session);
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
        const today = formatDateOnly(createdAt);

        return this.tx.run(async (ctx) => {
            const service = await this.repository.findById(serviceId, ctx.session);

            if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

            const option = service.options.find((item) => item.id === input.option_id);
            const slot = option?.slots.find((item) => item.id === input.slot_id);

            if (!option || !slot) throw ApiError.notFound('SLOT_NOT_FOUND');

            if (!option.enabled) throw ApiError.unprocessable('OPTION_DISABLED');

            if (!BOOKABLE_SLOT_TYPES.includes(slot.child_type))
                throw ApiError.unprocessable('SLOT_NOT_BOOKABLE');

            if (typeof slot.value.date === 'string' && slot.value.date < today)
                throw ApiError.unprocessable('SLOT_EXPIRED');

            let time: string | undefined;
            let limit: number | null;

            if (slot.child_type === 'date_time') {
                if (!input.time) throw ApiError.unprocessable('SLOT_TIME_REQUIRED');

                const entry = (slot.value.time ?? []).find((item) => item.time === input.time);

                if (!entry) throw ApiError.notFound('SLOT_NOT_FOUND');

                time = entry.time;
                limit = entry.limit;
            } else {
                limit = slot.value.limit ?? null;
            }

            const booking: Booking = {
                id: bookingId,
                service_id: service._id,
                organization_id: service.organization_id,
                option_id: option.id,
                slot_id: slot.id,
                child_type: slot.child_type,
                slot_date: slot.value.date ?? null,
                slot_time: time ?? null,
                service_label: service.value.heading_value ?? service.label,
                user_id: new Types.ObjectId(actor.id),
                person: actor.name ?? '',
                phone: actor.phone ?? '',
                info: input.info ?? '',
            };

            try {
                await this.bookings.create(booking, ctx.session);
            } catch (error) {
                if ((error as { code?: number }).code === DUPLICATE_KEY)
                    throw ApiError.conflict('BOOKING_ALREADY_EXISTS');

                throw error;
            }

            const accepted =
                time === undefined
                    ? await this.repository.incrementSlotCount(
                          serviceId,
                          option.id,
                          slot.id,
                          limit,
                          ctx.session,
                      )
                    : await this.repository.incrementTimeCount(
                          serviceId,
                          option.id,
                          slot.id,
                          time,
                          limit,
                          ctx.session,
                      );

            if (!accepted) throw ApiError.unprocessable('SLOT_FULL');

            const subscribe = service.value.subscribe;

            if (subscribe) {
                ctx.afterCommit(() =>
                    this.mail.sendBookingNotification(subscribe, {
                        service: service.value.heading_value ?? service.label,
                        date: slot.value.date,
                        time,
                        phone: booking.phone,
                        name: booking.person,
                    }),
                );
            }

            return {
                booking_id: bookingId,
                service_id: serviceId,
                organization_id: service.organization_id.toHexString(),
                option_id: option.id,
                slot_id: slot.id,
                child_type: slot.child_type,
                date: slot.value.date,
                time,
                created_at: createdAt.toISOString(),
            };
        });
    }

    list(query: ListBookingsQuery, actor: AuthUser): Promise<PaginatedResult<BookingResource>> {
        const filter: FilterQuery<Booking> = {};

        if (actor.role !== ROLES.SUPER_ADMIN) {
            const allowed = actor.organization_ids.map((id) => new Types.ObjectId(id));

            if (query.organization_id && !actor.organization_ids.includes(query.organization_id))
                throw ApiError.forbidden('FORBIDDEN');

            filter['organization_id'] = query.organization_id
                ? new Types.ObjectId(query.organization_id)
                : { $in: allowed };
        } else if (query.organization_id) {
            filter['organization_id'] = new Types.ObjectId(query.organization_id);
        }

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

    cancelById(
        bookingId: string,
        actor: AuthUser,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.remove(bookingId, actor);
    }

    private async paginate(
        filter: FilterQuery<Booking>,
        query: { page?: number; limit?: number; sort?: string; order?: 'asc' | 'desc' } & {
            date_from?: string;
            date_to?: string;
        },
    ): Promise<PaginatedResult<BookingResource>> {
        const pagination = this.pagination.resolve(query, {
            sortable: BOOKING_SORTABLE,
            defaultSort: 'created_at',
        });
        const dated: FilterQuery<Booking> = { ...filter };

        if (query.date_from || query.date_to) {
            dated['slot_date'] = {
                ...(query.date_from ? { $gte: query.date_from } : {}),
                ...(query.date_to ? { $lte: query.date_to } : {}),
            };
        }

        const result = await this.bookings.list(dated, pagination);

        return { ...result, items: result.items.map(toResource) };
    }

    /**
     * The booking's owner or an admin of the service's organization may cancel. The booking row
     * carries its organization, so neither check needs the service document any more.
     */
    async cancel(
        serviceId: string,
        bookingId: string,
        actor: AuthUser,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.remove(bookingId, actor, serviceId);
    }

    private async remove(
        bookingId: string,
        actor: AuthUser,
        serviceId?: string,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.tx.run(async (ctx) => {
            const booking = await this.bookings.findByPublicId(bookingId, ctx.session);

            if (!booking || (serviceId !== undefined && booking.service_id.toHexString() !== serviceId))
                throw ApiError.notFound('BOOKING_NOT_FOUND');

            const ownerId = booking.user_id.toHexString();

            if (
                ownerId !== actor.id &&
                !this.masker.canSeeDetails(actor, booking.organization_id.toHexString())
            ) {
                throw ApiError.forbidden('FORBIDDEN');
            }

            if (!(await this.bookings.deleteByPublicId(bookingId, ctx.session)))
                throw ApiError.notFound('BOOKING_NOT_FOUND');

            await this.releaseCapacity(booking, ctx.session);

            return {
                user_id: ownerId,
                date: booking.slot_date ?? undefined,
                time: booking.slot_time ?? undefined,
                child_type: booking.child_type,
            };
        });
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
