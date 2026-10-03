import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type ClientSession, Types } from 'mongoose';

import { AppConfig } from '../../common/config/app-config';
import { SLOT_BULK_MAX_BOOKINGS } from '../../common/config/constants';
import { type TransactionContext, TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { type EnqueueRequest, OutboxService } from '../../common/outbox/outbox.service';
import { dateOnlyIn, instantIn } from '../../common/time/zone';
import { MailService } from '../../integrations/mail/mail.service';
import { type BookingEntity, BookingsRepository } from '../bookings/bookings.repository';
import { WaitlistRepository } from '../bookings/waitlist.repository';
import { OrganizationsService } from '../organizations/organizations.service';
import { type SlotBody } from '../slots/schemas/slot.schema';
import { SlotsRepository } from '../slots/slots.repository';
import { ChannelTemplatesService } from '../channel-templates/channel-templates.service';
import { SmsService } from '../sms/sms.service';
import { UsersService } from '../users/users.service';
import {
    announced,
    eventActor,
    eventPayload,
    notice,
    organizationOf,
    previousOf,
    recipientEmail,
} from './booking-events';
import { BookingsService } from './bookings.service';
import {
    type CloseSlotInput,
    type CloseSlotResult,
    type MoveSlotInput,
    type MoveSlotResult,
} from './dto/service.schemas';
import { BOOKABLE_SLOT_TYPES, DATED_SLOT_TYPES, TIMED_SLOT_TYPES } from './schemas/service.schema';
import { ServicesRepository } from './services.repository';
import { ServicesService, type ServiceTreeEntity } from './services.service';
import { minutesOf, optionOf, slotOf, timeOf } from './slot.logic';

const DAY_MINUTES = 24 * 60;

interface Timed {
    slot_time: string | null;
}

type Announcement = { type: EnqueueRequest['type']; payload: EnqueueRequest['payload'] };

function byShift(minutes: number) {
    return (left: Timed, right: Timed): number =>
        minutes > 0
            ? (right.slot_time ?? '').localeCompare(left.slot_time ?? '')
            : (left.slot_time ?? '').localeCompare(right.slot_time ?? '');
}

@Injectable()
export class SlotAdminService implements OnModuleInit {
    constructor(
        private readonly services: ServicesService,
        private readonly lifecycle: BookingsService,
        private readonly repository: ServicesRepository,
        private readonly slots: SlotsRepository,
        private readonly bookings: BookingsRepository,
        private readonly waitlist: WaitlistRepository,
        private readonly users: UsersService,
        private readonly mail: MailService,
        private readonly sms: SmsService,
        private readonly templates: ChannelTemplatesService,
        private readonly outbox: OutboxService,
        private readonly idempotency: IdempotencyService,
        private readonly tx: TransactionRunner,
        private readonly organizations: OrganizationsService,
        private readonly config: AppConfig,
    ) {}

    private async timeZoneOf(service: { organization_id: Types.ObjectId }): Promise<string> {
        return (
            (await this.organizations.timezoneOf(service.organization_id.toHexString())) ??
            this.config.jobs.timezone
        );
    }

    onModuleInit(): void {
        this.outbox.registerHandler('booking.cancelled', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!announced(event) || !email) return;

            const message = await this.templates.mail(
                organizationOf(event),
                'booking_cancelled_mail',
                notice(event),
            );
            await this.mail.send({ to: [email], ...message });
        });
        this.outbox.registerHandler('booking.cancelled', 'sms', async (event) => {
            const { phone, ...data } = notice(event);

            if (!announced(event) || recipientEmail(event) || !phone) return;

            await this.sms.send(
                phone,
                await this.templates.sms(organizationOf(event), 'booking_cancelled_sms', data),
                'cancellation',
            );
        });
        this.outbox.registerHandler('booking.rescheduled', 'mail', async (event) => {
            const email = recipientEmail(event);

            if (!announced(event) || !email) return;

            const message = await this.templates.mail(organizationOf(event), 'booking_moved_mail', {
                ...notice(event),
                ...previousOf(event),
            });
            await this.mail.send({ to: [email], ...message });
        });
        this.outbox.registerHandler('booking.rescheduled', 'sms', async (event) => {
            const { phone, ...data } = notice(event);

            if (!announced(event) || recipientEmail(event) || !phone) return;

            await this.sms.send(
                phone,
                await this.templates.sms(organizationOf(event), 'booking_moved_sms', {
                    ...data,
                    ...previousOf(event),
                }),
                'reschedule',
            );
        });
    }

    close(
        serviceId: string,
        optionId: string,
        slotId: string,
        input: CloseSlotInput,
        actor: AuthUser,
        key?: string,
    ): Promise<{ result: CloseSlotResult; replayed: boolean }> {
        return this.once('slots.close', key, actor, { serviceId, optionId, slotId, input }, () =>
            this.runClose(serviceId, optionId, slotId, input, actor),
        );
    }

    move(
        serviceId: string,
        optionId: string,
        slotId: string,
        input: MoveSlotInput,
        actor: AuthUser,
        key?: string,
    ): Promise<{ result: MoveSlotResult; replayed: boolean }> {
        return this.once('slots.move', key, actor, { serviceId, optionId, slotId, input }, () =>
            this.runMove(serviceId, optionId, slotId, input, actor),
        );
    }

    private runClose(
        serviceId: string,
        optionId: string,
        slotId: string,
        input: CloseSlotInput,
        actor: AuthUser,
    ): Promise<CloseSlotResult> {
        return this.tx.run(async (ctx) => {
            const before = await this.services.load(serviceId, ctx.session);
            const slot = slotOf(optionOf(before, optionId), slotId);

            if (!BOOKABLE_SLOT_TYPES.includes(slot.child_type))
                throw ApiError.unprocessable('SLOT_NOT_BOOKABLE');

            const time = this.resolveTime(slot, input.time);
            const closing = input.remove === true;
            const bookings = await this.affectedBookings(serviceId, optionId, slotId, time, ctx.session);
            const cancelled = await this.bookings.cancelMany(
                bookings.map((booking) => booking.id),
                new Types.ObjectId(actor.id),
                new Date(),
                ctx.session,
            );

            if (closing) await this.drop(serviceId, optionId, slot, time, ctx.session);
            else await this.clearCounters(serviceId, optionId, slot, time, ctx.session);

            const dropped = closing
                ? await this.waitlist.deleteBySlot(serviceId, optionId, slotId, time, ctx.session)
                : 0;

            if (!closing) for (const booking of bookings) await this.lifecycle.notifyWaitlist(booking, ctx);

            const queued = await this.announce(bookings, input.notify !== false, actor, ctx, (booking) => ({
                type: 'booking.cancelled',
                payload: eventPayload(booking, {
                    status: 'cancelled',
                    cancelled_by: 'admin',
                    bulk: true,
                    reason: input.reason ?? null,
                }),
            }));

            if (closing) await this.repository.touch(serviceId, ctx.session);

            const after = await this.services.load(serviceId, ctx.session);
            const removed = this.gone(after, optionId, slotId, time);

            if (removed) await this.services.recordSlotChange(before, after, actor, ctx.session);

            return {
                service_id: serviceId,
                option_id: optionId,
                slot_id: slotId,
                time: time ?? null,
                cancelled,
                waitlist_dropped: dropped,
                notifications_queued: queued,
                removed,
            };
        });
    }

    private runMove(
        serviceId: string,
        optionId: string,
        slotId: string,
        input: MoveSlotInput,
        actor: AuthUser,
    ): Promise<MoveSlotResult> {
        return this.tx.run(async (ctx) => {
            const before = await this.services.load(serviceId, ctx.session);
            const option = optionOf(before, optionId);
            const slot = slotOf(option, slotId);

            if (!DATED_SLOT_TYPES.includes(slot.child_type)) throw ApiError.unprocessable('SLOT_NOT_DATED');

            const timeZone = await this.timeZoneOf(before);

            if (input.date < dateOnlyIn(new Date(), timeZone)) throw ApiError.unprocessable('SLOT_EXPIRED');

            if (
                slot.child_type !== 'time_range' &&
                option.slots.some(
                    (item) =>
                        item.id !== slotId &&
                        item.child_type !== 'time_range' &&
                        item.value.date === input.date,
                )
            )
                throw ApiError.conflict('SLOT_DATE_TAKEN');

            const previousDate = slot.value.date ?? '';
            const minutes = input.shift_minutes ?? 0;
            const shifted = this.shift(slot, minutes);
            const summary = {
                service_id: serviceId,
                option_id: optionId,
                slot_id: slotId,
                date: input.date,
                previous_date: previousDate,
            };

            if (previousDate === input.date && minutes === 0)
                return { ...summary, moved: 0, notifications_queued: 0 };

            const bookings = await this.affectedBookings(serviceId, optionId, slotId, undefined, ctx.session);
            const waiting = await this.affectedWaiting(serviceId, optionId, slotId, ctx.session);

            if (previousDate !== input.date)
                await this.slots.setFields(
                    serviceId,
                    optionId,
                    slotId,
                    { 'value.date': input.date },
                    ctx.session,
                );

            await this.slots.renameTimes(
                serviceId,
                optionId,
                slotId,
                this.renameOrder(shifted, minutes),
                ctx.session,
            );
            await this.shiftEnds(serviceId, optionId, slot, minutes, ctx.session);
            const moved = await this.bookings.moveMany(
                this.destinations(bookings, input.date, minutes, timeZone),
                ctx.session,
            );
            await this.waitlist.moveMany(
                this.destinations(waiting, input.date, minutes, timeZone),
                ctx.session,
            );

            const queued = await this.announce(bookings, input.notify !== false, actor, ctx, (booking) => ({
                type: 'booking.rescheduled',
                payload: eventPayload(booking, {
                    date: input.date,
                    time: this.movedTime(booking.slot_time, minutes),
                    end_time: this.movedTime(booking.slot_end ?? null, minutes),
                    bulk: true,
                    reason: input.reason ?? null,
                    previous: {
                        option_id: booking.option_id,
                        slot_id: booking.slot_id,
                        date: booking.slot_date,
                        time: booking.slot_time,
                        end_time: booking.slot_end ?? null,
                    },
                }),
            }));
            await this.repository.touch(serviceId, ctx.session);
            const after = await this.services.load(serviceId, ctx.session);
            await this.services.recordSlotChange(before, after, actor, ctx.session);

            return { ...summary, moved, notifications_queued: queued };
        });
    }

    private async once<T extends object>(
        scope: string,
        key: string | undefined,
        actor: AuthUser,
        request: unknown,
        work: () => Promise<T>,
    ): Promise<{ result: T; replayed: boolean }> {
        if (!key) return { result: await work(), replayed: false };

        const outcome = await this.idempotency.run(
            scope,
            key,
            actor.id,
            request,
            async () => (await work()) as unknown as Record<string, unknown>,
        );

        return { result: outcome.result as unknown as T, replayed: outcome.replayed };
    }

    private async affectedBookings(
        serviceId: string,
        optionId: string,
        slotId: string,
        time: string | undefined,
        session: ClientSession,
    ): Promise<BookingEntity[]> {
        return this.capped(
            await this.bookings.findActiveBySlot(
                serviceId,
                optionId,
                slotId,
                time,
                SLOT_BULK_MAX_BOOKINGS + 1,
                session,
            ),
        );
    }

    private async affectedWaiting(
        serviceId: string,
        optionId: string,
        slotId: string,
        session: ClientSession,
    ): Promise<(Timed & { id: string })[]> {
        return this.capped(
            await this.waitlist.findBySlot(
                serviceId,
                optionId,
                slotId,
                undefined,
                SLOT_BULK_MAX_BOOKINGS + 1,
                session,
            ),
        );
    }

    private capped<T>(rows: T[]): T[] {
        if (rows.length > SLOT_BULK_MAX_BOOKINGS)
            throw ApiError.unprocessable('SLOT_BULK_TOO_LARGE', [
                { path: 'slot_id', message: `At most ${SLOT_BULK_MAX_BOOKINGS} rows per operation` },
            ]);

        return rows;
    }

    private async drop(
        serviceId: string,
        optionId: string,
        slot: SlotBody,
        time: string | undefined,
        session: ClientSession,
    ): Promise<void> {
        if (time === undefined) await this.slots.deleteSlots(serviceId, optionId, [slot.id], session);
        else await this.slots.pullTimes(serviceId, optionId, slot.id, [time], session);
    }

    private async clearCounters(
        serviceId: string,
        optionId: string,
        slot: SlotBody,
        time: string | undefined,
        session: ClientSession,
    ): Promise<void> {
        if (TIMED_SLOT_TYPES.includes(slot.child_type))
            await this.slots.clearTimeCounts(serviceId, optionId, slot.id, time, session);
        else await this.slots.clearSlotCount(serviceId, optionId, slot.id, session);
    }

    private gone(
        service: ServiceTreeEntity,
        optionId: string,
        slotId: string,
        time: string | undefined,
    ): boolean {
        const slot = service.options
            .find((item) => item.id === optionId)
            ?.slots.find((item) => item.id === slotId);

        if (!slot) return true;

        if (time === undefined) return false;

        return !(slot.value.time ?? []).some((entry) => entry.time === time);
    }

    private shift(slot: SlotBody, minutes: number): Map<string, string> {
        const moves = new Map<string, string>();

        if (minutes === 0) return moves;

        if (slot.child_type === 'date') throw ApiError.unprocessable('SLOT_NOT_TIMED');

        const bounds =
            slot.child_type === 'time_range'
                ? [slot.value.from ?? '', slot.value.to ?? '']
                : (slot.value.time ?? []).flatMap((entry) => (entry.to ? [entry.to] : []));

        for (const time of bounds) this.shiftedTime(time, minutes);

        for (const entry of slot.value.time ?? [])
            moves.set(entry.time, this.shiftedTime(entry.time, minutes));

        return moves;
    }

    private shiftedTime(time: string, minutes: number): string {
        const shifted = minutesOf(time) + minutes;

        if (shifted < 0 || shifted >= DAY_MINUTES)
            throw ApiError.unprocessable('SLOT_TIME_OUT_OF_RANGE', [
                { path: 'shift_minutes', message: `${time} would leave the day` },
            ]);

        return timeOf(shifted);
    }

    private async shiftEnds(
        serviceId: string,
        optionId: string,
        slot: SlotBody,
        minutes: number,
        session: ClientSession,
    ): Promise<void> {
        if (minutes === 0) return;

        if (slot.child_type === 'time_range') {
            await this.slots.setFields(
                serviceId,
                optionId,
                slot.id,
                {
                    'value.from': this.shiftedTime(slot.value.from ?? '', minutes),
                    'value.to': this.shiftedTime(slot.value.to ?? '', minutes),
                },
                session,
            );

            return;
        }

        for (const entry of slot.value.time ?? []) {
            if (!entry.to) continue;

            await this.slots.setTimeEnd(
                serviceId,
                optionId,
                slot.id,
                this.shiftedTime(entry.time, minutes),
                this.shiftedTime(entry.to, minutes),
                session,
            );
        }
    }

    private renameOrder(moves: Map<string, string>, minutes: number): [string, string][] {
        return [...moves.entries()].sort(([left], [right]) =>
            byShift(minutes)({ slot_time: left }, { slot_time: right }),
        );
    }

    private movedTime(time: string | null, minutes: number): string | null {
        if (time === null) return null;

        return timeOf(minutesOf(time) + minutes);
    }

    private destinations<T extends Timed & { id: string; slot_end?: string | null }>(
        rows: T[],
        date: string,
        minutes: number,
        timeZone: string,
    ): {
        id: string;
        slot_date: string;
        slot_time: string | null;
        starts_at: Date | null;
        slot_end?: string | null;
        ends_at?: Date | null;
    }[] {
        return [...rows].sort(byShift(minutes)).map((row) => {
            const time = this.movedTime(row.slot_time, minutes);
            const end = this.movedTime(row.slot_end ?? null, minutes);

            return {
                id: row.id,
                slot_date: date,
                slot_time: time,
                starts_at: instantIn(date, time, timeZone),
                ...(end === null ? {} : { slot_end: end, ends_at: instantIn(date, end, timeZone) }),
            };
        });
    }

    private async announce(
        bookings: BookingEntity[],
        notify: boolean,
        actor: AuthUser,
        ctx: TransactionContext,
        describe: (booking: BookingEntity) => Announcement,
    ): Promise<number> {
        if (bookings.length === 0) return 0;

        const emails = notify
            ? await this.users.findEmailsByIds(bookings.map((booking) => booking.user_id.toHexString()))
            : new Map<string, string>();

        await this.outbox.enqueueMany(
            bookings.map((booking) => ({
                ...describe(booking),
                organizationId: booking.organization_id,
                internal: {
                    actor: eventActor(actor, booking),
                    ...(notify
                        ? {
                              notify: true,
                              phone: booking.phone,
                              email: emails.get(booking.user_id.toHexString()) ?? null,
                          }
                        : {}),
                },
            })),
            ctx.session,
        );
        ctx.afterCommit(() => this.outbox.poke());

        return notify ? bookings.length : 0;
    }

    private resolveTime(slot: SlotBody, time: string | undefined): string | undefined {
        if (time === undefined) return undefined;

        if (!TIMED_SLOT_TYPES.includes(slot.child_type)) throw ApiError.unprocessable('SLOT_NOT_TIMED');

        if (!(slot.value.time ?? []).some((entry) => entry.time === time))
            throw ApiError.notFound('SLOT_NOT_FOUND');

        return time;
    }
}
