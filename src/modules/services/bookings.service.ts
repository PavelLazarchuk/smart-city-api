import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type ClientSession, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { MailService } from '../../integrations/mail/mail.service';
import { type BookingEntity, BookingsRepository } from '../bookings/bookings.repository';
import { type Booking } from '../bookings/schemas/booking.schema';
import { type BookingCreated, type CreateBookingInput } from './dto/service.schemas';
import { BOOKABLE_SLOT_TYPES } from './schemas/service.schema';
import { ServicesMasker } from './services.masker';
import { ServicesRepository } from './services.repository';
import { formatDateOnly } from './slot.logic';

const DUPLICATE_KEY = 11000;

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

    /**
     * The booking's owner or an admin of the service's organization may cancel. The booking row
     * carries its organization, so neither check needs the service document any more.
     */
    async cancel(
        serviceId: string,
        bookingId: string,
        actor: AuthUser,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.tx.run(async (ctx) => {
            const booking = await this.bookings.findByPublicId(bookingId, ctx.session);

            if (!booking || booking.service_id.toHexString() !== serviceId)
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
