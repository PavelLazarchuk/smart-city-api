import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { EVENT_TYPES, TrackEvent } from '../../common/decorators/track-event.decorator';
import { ApiError } from '../../common/http/api-error';
import { parseBody } from '../../common/http/parse-body';
import { Serialize, SerializeBy } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { BookingsService } from './bookings.service';
import {
    AvailabilityQueryDto,
    type AvailabilityResponse,
    AvailabilityResponseDto,
    availabilityResponseSchema,
    type BookingCreated,
    BookingCreatedResponseDto,
    bookingCreatedResponseSchema,
    CreateBookingDto,
    CreateOptionDto,
    CreateServiceDto,
    createSlotSchema,
    ListServicesQueryDto,
    MaskedServiceResponseDto,
    maskedServiceResponseSchema,
    RecurrenceDto,
    serviceSchemaForViewer,
    ServiceResponseDto,
    serviceResponseSchema,
    UpdateOptionDto,
    UpdateServiceDto,
    UpdateSlotDto,
} from './dto/service.schemas';
import { type ServiceEntity } from './services.repository';
import { ServicesService } from './services.service';

function parseIdempotencyKey(raw: string | undefined): string | undefined {
    const key = raw?.trim();

    if (!key) return undefined;

    if (key.length > 128)
        throw ApiError.badRequest('VALIDATION_ERROR', [
            { path: 'Idempotency-Key', message: 'Must be at most 128 characters' },
        ]);

    return key;
}

@ApiTags('services')
@Controller('services')
export class ServicesController {
    constructor(
        private readonly services: ServicesService,
        private readonly bookings: BookingsService,
    ) {}

    @Get()
    @Public()
    @ApiPaginated(MaskedServiceResponseDto)
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema, 'paginated')
    list(
        @Query() query: ListServicesQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<PaginatedResult<ServiceEntity>> {
        return this.services.list(query, user);
    }

    @Get(':id')
    @Public()
    @ApiData(MaskedServiceResponseDto)
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema)
    getOne(@Param('id') id: string, @CurrentUser() user?: AuthUser): Promise<ServiceEntity> {
        return this.services.getMasked(id, user);
    }

    @Get(':id/availability')
    @Public()
    @ApiData(AvailabilityResponseDto)
    @Serialize(availabilityResponseSchema)
    async availability(
        @Param('id') id: string,
        @Query() query: AvailabilityQueryDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<AvailabilityResponse> {
        res.setHeader('Cache-Control', 'public, max-age=60');

        return this.services.availability(id, query);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: ServiceResponseDto })
    @Serialize(serviceResponseSchema)
    async create(
        @Body() body: CreateServiceDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<ServiceEntity> {
        const service = await this.services.create(body, user);
        res.setHeader('Location', `/services/${service._id.toHexString()}`);

        return service;
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @Serialize(serviceResponseSchema)
    update(
        @Param('id') id: string,
        @Body() body: UpdateServiceDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceEntity> {
        return this.services.update(id, body, user);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.services.delete(id);
    }

    // ----- options and slots as sub-resources -----

    /**
     * Editing one option or slot no longer means sending the whole `options` array back: these routes
     * write with `arrayFilters`, so two admins editing neighbouring slots do not overwrite each other
     * and a booking committed in between is never lost.
     */
    @Post(':id/options')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiCreatedResponse({ type: ServiceResponseDto })
    @Serialize(serviceResponseSchema)
    addOption(
        @Param('id') id: string,
        @Body() body: CreateOptionDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceEntity> {
        return this.services.addOption(id, body, user);
    }

    @Patch(':id/options/:option_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @Serialize(serviceResponseSchema)
    updateOption(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Body() body: UpdateOptionDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceEntity> {
        return this.services.updateOption(id, optionId, body, user);
    }

    @Delete(':id/options/:option_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async removeOption(@Param('id') id: string, @Param('option_id') optionId: string): Promise<void> {
        await this.services.removeOption(id, optionId);
    }

    @Put(':id/options/:option_id/recurrence')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @Serialize(serviceResponseSchema)
    setRecurrence(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Body() body: RecurrenceDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceEntity> {
        return this.services.setRecurrence(id, optionId, body, user);
    }

    @Post(':id/options/:option_id/slots')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiBody({
        schema: {
            type: 'object',
            description: 'Slot payload, discriminated by child_type, as in options[].slots[] on create.',
        },
    })
    @ApiCreatedResponse({ type: ServiceResponseDto })
    @Serialize(serviceResponseSchema)
    addSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Body() body: unknown,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceEntity> {
        return this.services.addSlot(id, optionId, parseBody(createSlotSchema, body), user);
    }

    @Patch(':id/options/:option_id/slots/:slot_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @Serialize(serviceResponseSchema)
    updateSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Param('slot_id') slotId: string,
        @Body() body: UpdateSlotDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceEntity> {
        return this.services.updateSlot(id, optionId, slotId, body, user);
    }

    @Delete(':id/options/:option_id/slots/:slot_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async removeSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Param('slot_id') slotId: string,
    ): Promise<void> {
        await this.services.removeSlot(id, optionId, slotId);
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
    async createBooking(
        @Param('id') id: string,
        @Body() body: CreateBookingDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
        @Headers('idempotency-key') idempotencyKey?: string,
    ): Promise<BookingCreated> {
        const { booking, replayed } = await this.bookings.createIdempotent(
            id,
            body,
            user,
            parseIdempotencyKey(idempotencyKey),
        );
        res.setHeader('Location', `/me/bookings`);

        if (replayed) res.setHeader('Idempotency-Replayed', 'true');

        return booking;
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
