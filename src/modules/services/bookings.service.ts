import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { MailService } from '../../integrations/mail/mail.service';
import { UsersService } from '../users/users.service';
import { type BookingCreated, type CreateBookingInput } from './dto/service.schemas';
import { type Booking, BOOKABLE_SLOT_TYPES } from './schemas/service.schema';
import { ServicesMasker } from './services.masker';
import { ServicesRepository } from './services.repository';
import { ServicesService } from './services.service';
import { findBookingsOfUser, formatDateOnly } from './slot.logic';

/**
 * Booking creation and cancellation: service slot and user booking list change in one transaction,
 * capacity is enforced by the conditional update, and the notification e-mail is sent only after
 * the commit.
 */
@Injectable()
export class BookingsService implements OnModuleInit {
    constructor(
        private readonly services: ServicesService,
        private readonly repository: ServicesRepository,
        private readonly users: UsersService,
        private readonly mail: MailService,
        private readonly masker: ServicesMasker,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('user', 'services.remove_user_bookings', async (userId, ctx) => {
            const services = await this.repository.findWithBookingsOfUser(userId, ctx.session);

            for (const service of services) {
                for (const found of findBookingsOfUser(service.options, userId)) {
                    if (found.time) {
                        await this.repository.pullTimeBooking(
                            service._id.toHexString(),
                            found.option_id,
                            found.slot_id,
                            found.time,
                            found.booking.id,
                            ctx.session,
                        );
                    } else {
                        await this.repository.pullSlotBooking(
                            service._id.toHexString(),
                            found.option_id,
                            found.slot_id,
                            found.booking.id,
                            ctx.session,
                        );
                    }
                }
            }
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

            const requestedTime = slot.child_type === 'date_time' ? input.time : undefined;

            if (
                findBookingsOfUser([option], actor.id).some(
                    (found) => found.slot_id === slot.id && found.time === requestedTime,
                )
            ) {
                throw ApiError.conflict('BOOKING_ALREADY_EXISTS');
            }

            const booking: Booking = {
                id: bookingId,
                user_id: new Types.ObjectId(actor.id),
                person: actor.name ?? '',
                phone: actor.phone ?? '',
                info: input.info ?? '',
                created_at: createdAt,
            };

            let accepted: boolean;
            let time: string | undefined;

            if (slot.child_type === 'date_time') {
                if (!input.time) throw ApiError.unprocessable('SLOT_TIME_REQUIRED');

                const entry = (slot.value.time ?? []).find((item) => item.time === input.time);

                if (!entry) throw ApiError.notFound('SLOT_NOT_FOUND');

                time = entry.time;
                accepted = await this.repository.pushTimeBooking(
                    serviceId,
                    option.id,
                    slot.id,
                    entry.time,
                    entry.limit,
                    booking,
                    ctx.session,
                );
            } else {
                accepted = await this.repository.pushSlotBooking(
                    serviceId,
                    option.id,
                    slot.id,
                    slot.value.limit ?? null,
                    booking,
                    ctx.session,
                );
            }

            if (!accepted) throw ApiError.unprocessable('SLOT_FULL');

            const result: BookingCreated = {
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
            await this.users.addBookingRef(
                actor.id,
                {
                    id: bookingId,
                    service_id: service._id,
                    organization_id: service.organization_id,
                    option_id: option.id,
                    slot_id: slot.id,
                    child_type: slot.child_type,
                    service_label: service.value.heading_value ?? service.label,
                    date: slot.value.date,
                    time,
                    created_at: createdAt,
                },
                ctx,
            );

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

            return result;
        });
    }

    /** The booking's owner or an admin of the service's organization may cancel. */
    async cancel(
        serviceId: string,
        bookingId: string,
        actor: AuthUser,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.tx.run(async (ctx) => {
            const service = await this.repository.findById(serviceId, ctx.session);

            if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

            const location = this.locate(service.options, bookingId);

            if (!location) throw ApiError.notFound('BOOKING_NOT_FOUND');

            const ownerId = location.booking.user_id.toHexString();
            const isOwner = ownerId === actor.id;

            if (!isOwner && !this.masker.canSeeDetails(actor, service.organization_id.toHexString())) {
                throw ApiError.forbidden('FORBIDDEN');
            }

            const removed = location.time
                ? await this.repository.pullTimeBooking(
                      serviceId,
                      location.option_id,
                      location.slot_id,
                      location.time,
                      bookingId,
                      ctx.session,
                  )
                : await this.repository.pullSlotBooking(
                      serviceId,
                      location.option_id,
                      location.slot_id,
                      bookingId,
                      ctx.session,
                  );

            if (!removed) throw ApiError.notFound('BOOKING_NOT_FOUND');

            await this.users.removeBookingRef(ownerId, bookingId, ctx);

            return {
                user_id: ownerId,
                date: location.date,
                time: location.time,
                child_type: location.child_type,
            };
        });
    }

    private locate(
        options: {
            id: string;
            slots: {
                id: string;
                child_type: string;
                value: {
                    date?: string;
                    bookings?: Booking[];
                    time?: { time: string; bookings: Booking[] }[];
                };
            }[];
        }[],
        bookingId: string,
    ): {
        option_id: string;
        slot_id: string;
        child_type: string;
        date?: string;
        time?: string;
        booking: Booking;
    } | null {
        for (const option of options) {
            for (const slot of option.slots) {
                const direct = (slot.value.bookings ?? []).find((booking) => booking.id === bookingId);

                if (direct)
                    return {
                        option_id: option.id,
                        slot_id: slot.id,
                        child_type: slot.child_type,
                        date: slot.value.date,
                        booking: direct,
                    };

                for (const entry of slot.value.time ?? []) {
                    const found = entry.bookings.find((booking) => booking.id === bookingId);

                    if (found) {
                        return {
                            option_id: option.id,
                            slot_id: slot.id,
                            child_type: slot.child_type,
                            date: slot.value.date,
                            time: entry.time,
                            booking: found,
                        };
                    }
                }
            }
        }

        return null;
    }
}
