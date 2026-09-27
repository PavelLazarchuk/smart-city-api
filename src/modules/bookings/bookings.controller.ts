import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { EVENT_TYPES, TrackEvent } from '../../common/decorators/track-event.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { texts } from '../../common/i18n/messages';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { BookingCalendarService, type CalendarToken } from '../services/booking-calendar.service';
import { BookingsService } from '../services/bookings.service';
import {
    type BookingResource,
    BookingResourceDto,
    bookingResourceSchema,
    type BookingStats,
    BookingStatsQueryDto,
    BookingStatsResponseDto,
    bookingStatsResponseSchema,
    CalendarFeedQueryDto,
    CalendarTokenResponseDto,
    calendarTokenResponseSchema,
    ListBookingsQueryDto,
    ListOwnBookingsQueryDto,
    ListServiceBookingsQueryDto,
    ListWaitlistQueryDto,
    RescheduleBookingDto,
    SetBookingStatusDto,
    type WaitlistEntryResource,
    WaitlistEntryResponseDto,
    waitlistEntryResponseSchema,
} from './dto/booking.schemas';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller()
export class BookingsController {
    constructor(
        private readonly bookings: BookingsService,
        private readonly calendar: BookingCalendarService,
    ) {}

    @Get('bookings')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @ApiPaginated(BookingResourceDto)
    @SerializePaginated(bookingResourceSchema)
    list(
        @Query() query: ListBookingsQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<BookingResource>> {
        return this.bookings.list(query, user);
    }

    @Get('bookings/stats')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @ApiData(BookingStatsResponseDto)
    @Serialize(bookingStatsResponseSchema)
    stats(@Query() query: BookingStatsQueryDto, @CurrentUser() user: AuthUser): Promise<BookingStats> {
        return this.bookings.stats(query, user);
    }

    @Get('me/bookings')
    @ApiPaginated(BookingResourceDto)
    @SerializePaginated(bookingResourceSchema)
    own(
        @Query() query: ListOwnBookingsQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<BookingResource>> {
        return this.bookings.listOwn(query, user);
    }

    @Get('me/bookings.ics')
    @Public()
    @ApiProduces('text/calendar')
    @ApiOkResponse({ schema: { type: 'string' } })
    @ApiErrors('TOKEN_INVALID')
    async feed(@Query() query: CalendarFeedQueryDto, @Res() res: Response): Promise<void> {
        const body = await this.calendar.feed(query.token);
        res.setHeader('Content-Type', texts.calendar.contentType);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.send(body);
    }

    @Post('me/calendar-token')
    @ApiCreatedResponse({ type: CalendarTokenResponseDto })
    @Serialize(calendarTokenResponseSchema)
    issueCalendarToken(@CurrentUser() user: AuthUser): Promise<CalendarToken> {
        return this.calendar.issueToken(user);
    }

    @Delete('me/calendar-token')
    @HttpCode(HttpStatus.NO_CONTENT)
    async revokeCalendarToken(@CurrentUser() user: AuthUser): Promise<void> {
        await this.calendar.revokeToken(user);
    }

    @Get('me/waitlist')
    @ApiPaginated(WaitlistEntryResponseDto)
    @SerializePaginated(waitlistEntryResponseSchema)
    ownWaitlist(
        @Query() query: ListWaitlistQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<WaitlistEntryResource>> {
        return this.bookings.listOwnWaitlist(query, user);
    }

    @Delete('waitlist/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('WAITLIST_NOT_FOUND')
    async leaveWaitlist(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
        await this.bookings.leaveWaitlist(id, user);
    }

    @Get('services/:id/bookings')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiPaginated(BookingResourceDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @SerializePaginated(bookingResourceSchema)
    forService(
        @Param('id') id: string,
        @Query() query: ListServiceBookingsQueryDto,
    ): Promise<PaginatedResult<BookingResource>> {
        return this.bookings.listForService(id, query);
    }

    @Get('bookings/:booking_id')
    @ApiData(BookingResourceDto)
    @ApiErrors('BOOKING_NOT_FOUND')
    @Serialize(bookingResourceSchema)
    getOne(@Param('booking_id') bookingId: string, @CurrentUser() user: AuthUser): Promise<BookingResource> {
        return this.bookings.getById(bookingId, user);
    }

    @Get('bookings/:booking_id/calendar.ics')
    @ApiProduces('text/calendar')
    @ApiOkResponse({ schema: { type: 'string' } })
    @ApiErrors('BOOKING_NOT_FOUND', 'BOOKING_NOT_DATED')
    async calendarOf(
        @Param('booking_id') bookingId: string,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ): Promise<void> {
        const body = await this.calendar.forBooking(bookingId, user);
        res.setHeader('Content-Type', texts.calendar.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${texts.calendar.fileName}"`);
        res.send(body);
    }

    @Patch('bookings/:booking_id/status')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @ApiData(BookingResourceDto)
    @ApiErrors('BOOKING_NOT_FOUND', 'BOOKING_STATUS_TRANSITION', 'BOOKING_NOT_ACTIVE')
    @Serialize(bookingResourceSchema)
    setStatus(
        @Param('booking_id') bookingId: string,
        @Body() body: SetBookingStatusDto,
        @CurrentUser() user: AuthUser,
    ): Promise<BookingResource> {
        return this.bookings.setStatus(bookingId, body.status, user);
    }

    @Post('bookings/:booking_id/confirm')
    @HttpCode(HttpStatus.OK)
    @ApiData(BookingResourceDto)
    @ApiErrors('BOOKING_NOT_FOUND', 'BOOKING_STATUS_TRANSITION')
    @Serialize(bookingResourceSchema)
    confirm(@Param('booking_id') bookingId: string, @CurrentUser() user: AuthUser): Promise<BookingResource> {
        return this.bookings.confirm(bookingId, user);
    }

    @Post('bookings/:booking_id/reschedule')
    @HttpCode(HttpStatus.OK)
    @ApiData(BookingResourceDto)
    @ApiErrors(
        'BOOKING_NOT_FOUND',
        'BOOKING_NOT_ACTIVE',
        'BOOKING_CANCEL_DEADLINE_PASSED',
        'SLOT_NOT_FOUND',
        'OPTION_DISABLED',
        'SLOT_NOT_BOOKABLE',
        'SLOT_EXPIRED',
        'SLOT_TIME_REQUIRED',
        'SLOT_FULL',
        'BOOKING_LEAD_TIME',
        'BOOKING_TOO_FAR_AHEAD',
        'BOOKING_ALREADY_EXISTS',
        'BOOKING_ADDRESS_REQUIRED',
        'SLOT_RANGE_INVALID',
    )
    @Serialize(bookingResourceSchema)
    reschedule(
        @Param('booking_id') bookingId: string,
        @Body() body: RescheduleBookingDto,
        @CurrentUser() user: AuthUser,
    ): Promise<BookingResource> {
        return this.bookings.reschedule(bookingId, body, user);
    }

    @Delete('bookings/:booking_id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('BOOKING_NOT_FOUND', 'BOOKING_NOT_ACTIVE', 'BOOKING_CANCEL_DEADLINE_PASSED')
    @TrackEvent(EVENT_TYPES.BOOKING_CANCELLED, (result) => {
        const cancelled = result as { date?: string; time?: string; child_type: string };

        return { child_type: cancelled.child_type, date: cancelled.date, time: cancelled.time };
    })
    async cancel(
        @Param('booking_id') bookingId: string,
        @CurrentUser() user: AuthUser,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.bookings.cancelById(bookingId, user);
    }
}
