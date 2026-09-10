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
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { EVENT_TYPES, TrackEvent } from '../../common/decorators/track-event.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { BookingsService } from './bookings.service';
import {
    type BookingCreated,
    BookingCreatedResponseDto,
    bookingCreatedResponseSchema,
    CreateBookingDto,
    CreateServiceDto,
    ListServicesQueryDto,
    ServiceResponseDto,
    serviceResponseSchema,
    UpdateServiceDto,
} from './dto/service.schemas';
import { type ServiceEntity } from './services.repository';
import { ServicesService } from './services.service';

@ApiTags('services')
@Controller('services')
export class ServicesController {
    constructor(
        private readonly services: ServicesService,
        private readonly bookings: BookingsService,
    ) {}

    @Get()
    @Public()
    @ApiPaginated(ServiceResponseDto)
    @SerializePaginated(serviceResponseSchema)
    list(
        @Query() query: ListServicesQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<PaginatedResult<ServiceEntity>> {
        return this.services.list(query, user);
    }

    @Get(':id')
    @Public()
    @ApiData(ServiceResponseDto)
    @Serialize(serviceResponseSchema)
    getOne(@Param('id') id: string, @CurrentUser() user?: AuthUser): Promise<ServiceEntity> {
        return this.services.getMasked(id, user);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: ServiceResponseDto })
    @Serialize(serviceResponseSchema)
    async create(
        @Body() body: CreateServiceDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<ServiceEntity> {
        const service = await this.services.create(body);
        res.setHeader('Location', `/services/${service._id.toHexString()}`);

        return service;
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @Serialize(serviceResponseSchema)
    update(@Param('id') id: string, @Body() body: UpdateServiceDto): Promise<ServiceEntity> {
        return this.services.update(id, body);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.services.delete(id);
    }

    /** Authenticated, any role: a booking always belongs to the calling user. */
    @Post(':id/bookings')
    @ApiBearerAuth()
    @ApiCreatedResponse({ type: BookingCreatedResponseDto })
    @Serialize(bookingCreatedResponseSchema)
    @TrackEvent(EVENT_TYPES.BOOKING_CREATED, (result) => {
        const booking = result as BookingCreated;

        return {
            organization_id: booking.organization_id,
            service_id: booking.service_id,
            child_type: booking.child_type,
            date: booking.date,
            time: booking.time,
        };
    })
    createBooking(
        @Param('id') id: string,
        @Body() body: CreateBookingDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<BookingCreated> {
        res.setHeader('Location', `/users/${user.id}/bookings`);

        return this.bookings.create(id, body, user);
    }

    @Delete(':id/bookings/:booking_id')
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    @TrackEvent(EVENT_TYPES.BOOKING_CANCELLED, (result) => {
        const cancelled = result as { date?: string; time?: string; child_type: string };

        return { child_type: cancelled.child_type, date: cancelled.date, time: cancelled.time };
    })
    async cancelBooking(
        @Param('id') id: string,
        @Param('booking_id') bookingId: string,
        @CurrentUser() user: AuthUser,
    ): Promise<{ user_id: string; date?: string; time?: string; child_type: string }> {
        return this.bookings.cancel(id, bookingId, user);
    }
}
