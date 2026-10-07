import { Injectable } from '@nestjs/common';

import { type CalendarEvent, type CalendarEventStatus, renderCalendar } from '../../common/calendar/ics';
import { AppConfig } from '../../common/config/app-config';
import { CALENDAR_FEED } from '../../common/config/constants';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { DAY_MS } from '../../common/time/zone';
import { type MailAttachment } from '../../integrations/mail/mail.provider';
import { type BookingEntity, BookingsRepository } from './bookings.repository';
import { type BookingStatus } from './schemas/booking.schema';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { ServicesMasker } from '../services/services.masker';
import { ServicesService } from '../services/services.service';

const STATUS: Record<BookingStatus, CalendarEventStatus> = {
    pending: 'TENTATIVE',
    confirmed: 'CONFIRMED',
    arrived: 'CONFIRMED',
    completed: 'CONFIRMED',
    no_show: 'CONFIRMED',
    cancelled: 'CANCELLED',
};

export interface CalendarToken {
    token: string;
    path: string;
}

@Injectable()
export class BookingCalendarService {
    constructor(
        private readonly bookings: BookingsRepository,
        private readonly services: ServicesService,
        private readonly organizations: OrganizationsService,
        private readonly users: UsersService,
        private readonly masker: ServicesMasker,
        private readonly config: AppConfig,
    ) {}

    async forBooking(bookingId: string, actor: AuthUser): Promise<string> {
        const booking = await this.bookings.findByPublicId(bookingId);

        if (
            !booking ||
            (booking.user_id.toHexString() !== actor.id &&
                !this.masker.canSeeDetails(actor, booking.organization_id.toHexString()))
        )
            throw ApiError.notFound('BOOKING_NOT_FOUND');

        if (!booking.starts_at) throw ApiError.unprocessable('BOOKING_NOT_DATED');

        return renderCalendar(await this.events([booking]));
    }

    async attachment(bookingId: string): Promise<MailAttachment | null> {
        const booking = bookingId ? await this.bookings.findByPublicId(bookingId) : null;

        if (!booking?.starts_at) return null;

        return {
            filename: texts.calendar.fileName,
            content: Buffer.from(renderCalendar(await this.events([booking])), 'utf8'),
            content_type: texts.calendar.contentType,
        };
    }

    async feed(token: string | undefined): Promise<string> {
        const user = token ? await this.users.findByCalendarToken(token) : null;

        if (!user) throw ApiError.unauthorized('TOKEN_INVALID');

        const now = new Date();
        const since = new Date(now.getTime() - CALENDAR_FEED.pastDays * DAY_MS);
        const bookings = await this.bookings.findScheduledByUser(
            user._id,
            since,
            now,
            CALENDAR_FEED.maxEvents,
        );

        return renderCalendar(await this.events(bookings), {
            name: texts.calendar.feedName,
            refresh_minutes: CALENDAR_FEED.refreshMinutes,
        });
    }

    async issueToken(actor: AuthUser): Promise<CalendarToken> {
        const token = await this.users.issueCalendarToken(actor.id);

        return { token, path: `/${this.config.http.prefix}/me/bookings.ics?token=${token}` };
    }

    revokeToken(actor: AuthUser): Promise<void> {
        return this.users.revokeCalendarToken(actor.id);
    }

    private async events(bookings: BookingEntity[]): Promise<CalendarEvent[]> {
        const [services, organizations] = await Promise.all([
            this.services.findCalendarDetails([
                ...new Set(bookings.map((booking) => booking.service_id.toHexString())),
            ]),
            this.organizations.findManyByIds(
                bookings.map((booking) => booking.organization_id.toHexString()),
            ),
        ]);
        const serviceById = new Map(services.map((service) => [service._id.toHexString(), service]));
        const organizationById = new Map(
            organizations.map((organization) => [organization._id.toHexString(), organization]),
        );
        const host = new URL(this.config.site.publicUrl).hostname;

        return bookings.flatMap((booking) => {
            if (!booking.starts_at) return [];

            const service = serviceById.get(booking.service_id.toHexString());
            const organization = organizationById.get(booking.organization_id.toHexString());
            const date = booking.slot_time === null && booking.slot_date ? booking.slot_date : undefined;
            const duration = service?.duration_minutes;
            const point = service?.location ?? organization?.location;
            const [lng, lat] = point?.coordinates ?? [];
            const event: CalendarEvent = {
                uid: `booking-${booking.id}@${host}`,
                summary: booking.service_label || texts.calendar.untitledEvent,
                description: organization?.main_label,
                location: service?.address || organization?.address || undefined,
                geo: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
                starts_at: booking.starts_at,
                ends_at:
                    booking.ends_at ??
                    (!date && duration ? new Date(booking.starts_at.getTime() + duration * 60_000) : null),
                date,
                status: STATUS[booking.status],
                sequence: booking.sequence ?? 0,
                updated_at: booking.updated_at,
            };

            return [event];
        });
    }
}
