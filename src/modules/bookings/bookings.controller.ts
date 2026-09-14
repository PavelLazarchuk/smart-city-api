import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { EVENT_TYPES, TrackEvent } from '../../common/decorators/track-event.decorator';
import { SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { BookingsService } from '../services/bookings.service';
import {
    type BookingResource,
    BookingResourceDto,
    bookingResourceSchema,
    ListBookingsQueryDto,
    ListOwnBookingsQueryDto,
    ListServiceBookingsQueryDto,
} from './dto/booking.schemas';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller()
export class BookingsController {
    constructor(private readonly bookings: BookingsService) {}

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

    @Get('me/bookings')
    @ApiPaginated(BookingResourceDto)
    @SerializePaginated(bookingResourceSchema)
    own(
        @Query() query: ListOwnBookingsQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<PaginatedResult<BookingResource>> {
        return this.bookings.listOwn(query, user);
    }

    @Get('services/:id/bookings')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiPaginated(BookingResourceDto)
    @SerializePaginated(bookingResourceSchema)
    forService(
        @Param('id') id: string,
        @Query() query: ListServiceBookingsQueryDto,
    ): Promise<PaginatedResult<BookingResource>> {
        return this.bookings.listForService(id, query);
    }

    @Delete('bookings/:booking_id')
    @HttpCode(HttpStatus.NO_CONTENT)
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
