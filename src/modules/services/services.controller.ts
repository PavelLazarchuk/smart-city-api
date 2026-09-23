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
import {
    Serialize,
    SerializeBy,
    SerializePaginated,
    SparseFields,
} from '../../common/http/serialize.decorator';
import { ApiErrors } from '../../common/openapi/api-errors.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto';
import {
    JoinWaitlistDto,
    ListWaitlistQueryDto,
    type WaitlistEntryResource,
    WaitlistEntryResponseDto,
    waitlistEntryResponseSchema,
} from '../bookings/dto/booking.schemas';
import { BookingsService } from './bookings.service';
import {
    AvailabilityQueryDto,
    type AvailabilityResponse,
    AvailabilityResponseDto,
    availabilityResponseSchema,
    type BookingCreated,
    BookingCreatedResponseDto,
    bookingCreatedResponseSchema,
    CloseSlotDto,
    CloseSlotResponseDto,
    closeSlotResponseSchema,
    type CloseSlotResult,
    CreateBookingDto,
    CreateOptionDto,
    CreateServiceDto,
    createSlotSchema,
    DeleteServiceQueryDto,
    GetServiceQueryDto,
    ListServicesQueryDto,
    MaskedServiceResponseDto,
    maskedServiceResponseSchema,
    MoveSlotDto,
    MoveSlotResponseDto,
    moveSlotResponseSchema,
    type MoveSlotResult,
    NearbyQueryDto,
    RecurrenceDto,
    ServiceResponseDto,
    serviceResponseSchema,
    ServiceRevisionResponseDto,
    serviceRevisionResponseSchema,
    serviceSchemaForViewer,
    ServiceSlotsQueryDto,
    type ServiceSlotsResponse,
    ServiceSlotsResponseDto,
    serviceSlotsResponseSchema,
    SetServiceStatusDto,
    UpdateOptionDto,
    UpdateServiceDto,
    UpdateSlotDto,
} from './dto/service.schemas';
import { type ServiceRevisionEntity } from './service-revisions.repository';
import { type ServiceListItem, ServicesService, type ServiceTreeEntity } from './services.service';
import { SlotAdminService } from './slot-admin.service';

function parseIdempotencyKey(raw: string | undefined): string | undefined {
    const key = raw?.trim();

    if (!key) return undefined;

    if (key.length > 128)
        throw ApiError.badRequest('VALIDATION_ERROR', [
            { path: 'Idempotency-Key', message: 'Must be at most 128 characters' },
        ]);

    return key;
}

const BOOKING_ERRORS = [
    'SERVICE_NOT_FOUND',
    'SLOT_NOT_FOUND',
    'OPTION_DISABLED',
    'SLOT_NOT_BOOKABLE',
    'SLOT_EXPIRED',
    'SLOT_TIME_REQUIRED',
    'SLOT_FULL',
    'SERVICE_NOT_PUBLISHED',
    'ORGANIZATION_CLOSED',
    'BOOKING_LIMIT_REACHED',
    'BOOKING_LEAD_TIME',
    'BOOKING_TOO_FAR_AHEAD',
    'BOOKING_FIELDS_INVALID',
    'BOOKING_DOCUMENTS_REQUIRED',
    'BOOKING_ALREADY_EXISTS',
    'IDEMPOTENCY_IN_PROGRESS',
    'IDEMPOTENCY_KEY_REUSED',
] as const;

@ApiTags('services')
@Controller('services')
export class ServicesController {
    constructor(
        private readonly services: ServicesService,
        private readonly bookings: BookingsService,
        private readonly slots: SlotAdminService,
    ) {}

    @Get()
    @Public()
    @ApiPaginated(MaskedServiceResponseDto)
    @ApiErrors('FIELDS_NOT_ALLOWED', 'PAGE_OUT_OF_RANGE')
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema, 'paginated')
    @SparseFields()
    list(
        @Query() query: ListServicesQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<PaginatedResult<ServiceListItem>> {
        return this.services.list(query, user);
    }

    @Get('nearby')
    @Public()
    @ApiData(MaskedServiceResponseDto)
    @ApiErrors('FIELDS_NOT_ALLOWED')
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema, 'list')
    @SparseFields()
    nearby(@Query() query: NearbyQueryDto, @CurrentUser() user?: AuthUser): Promise<ServiceListItem[]> {
        return this.services.nearby(query, user);
    }

    @Get(':id')
    @Public()
    @ApiData(MaskedServiceResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND', 'FIELDS_NOT_ALLOWED')
    @SerializeBy(serviceSchemaForViewer, maskedServiceResponseSchema)
    @SparseFields()
    getOne(
        @Param('id') id: string,
        @Query() query: GetServiceQueryDto,
        @CurrentUser() user?: AuthUser,
    ): Promise<ServiceListItem> {
        return this.services.getMasked(id, user, query);
    }

    @Get(':id/availability')
    @Public()
    @ApiData(AvailabilityResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @Serialize(availabilityResponseSchema)
    async availability(
        @Param('id') id: string,
        @Query() query: AvailabilityQueryDto,
        @Res({ passthrough: true }) res: Response,
        @CurrentUser() user?: AuthUser,
    ): Promise<AvailabilityResponse> {
        if (!user) res.setHeader('Cache-Control', 'public, max-age=60');

        return this.services.availability(id, query, user);
    }

    @Get(':id/slots')
    @Public()
    @ApiData(ServiceSlotsResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @Serialize(serviceSlotsResponseSchema)
    async slotCandidates(
        @Param('id') id: string,
        @Query() query: ServiceSlotsQueryDto,
        @Res({ passthrough: true }) res: Response,
        @CurrentUser() user?: AuthUser,
    ): Promise<ServiceSlotsResponse> {
        if (!user) res.setHeader('Cache-Control', 'public, max-age=60');

        return this.services.candidates(id, query, user);
    }

    @Get(':id/history')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiPaginated(ServiceRevisionResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @SerializePaginated(serviceRevisionResponseSchema)
    history(
        @Param('id') id: string,
        @Query() query: PaginationQueryDto,
    ): Promise<PaginatedResult<ServiceRevisionEntity>> {
        return this.services.history(id, query);
    }

    @Post()
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'body' })
    @ApiCreatedResponse({ type: ServiceResponseDto })
    @ApiErrors(
        'ORGANIZATION_NOT_FOUND',
        'CATEGORY_NOT_FOUND',
        'CATEGORY_ORGANIZATION_MISMATCH',
        'SERVICE_SLUG_TAKEN',
        'CONFLICT',
    )
    @Serialize(serviceResponseSchema)
    async create(
        @Body() body: CreateServiceDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
    ): Promise<ServiceTreeEntity> {
        const service = await this.services.create(body, user);
        res.setHeader('Location', `/services/${service._id.toHexString()}`);

        return service;
    }

    @Patch(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @ApiErrors(
        'SERVICE_NOT_FOUND',
        'CATEGORY_NOT_FOUND',
        'CATEGORY_ORGANIZATION_MISMATCH',
        'SERVICE_SLUG_TAKEN',
    )
    @Serialize(serviceResponseSchema)
    update(
        @Param('id') id: string,
        @Body() body: UpdateServiceDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
        return this.services.update(id, body, user);
    }

    @Put(':id/status')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @Serialize(serviceResponseSchema)
    setStatus(
        @Param('id') id: string,
        @Body() body: SetServiceStatusDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
        return this.services.setStatus(id, body.status, user);
    }

    @Delete(':id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('SERVICE_NOT_FOUND')
    async remove(
        @Param('id') id: string,
        @Query() query: DeleteServiceQueryDto,
        @CurrentUser() user: AuthUser,
    ): Promise<void> {
        if (query.permanent && user.role !== ROLES.SUPER_ADMIN) throw ApiError.forbidden('FORBIDDEN');

        await this.services.delete(id, user, query.permanent === true);
    }

    @Post(':id/restore')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.OK)
    @ApiData(ServiceResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND', 'SERVICE_NOT_DELETED')
    @Serialize(serviceResponseSchema)
    restore(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ServiceTreeEntity> {
        return this.services.restore(id, user);
    }

    @Post(':id/options')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiCreatedResponse({ type: ServiceResponseDto })
    @ApiErrors('SERVICE_NOT_FOUND', 'CONFLICT')
    @Serialize(serviceResponseSchema)
    addOption(
        @Param('id') id: string,
        @Body() body: CreateOptionDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
        return this.services.addOption(id, body, user);
    }

    @Patch(':id/options/:option_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND', 'OPTION_NOT_FOUND')
    @Serialize(serviceResponseSchema)
    updateOption(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Body() body: UpdateOptionDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
        return this.services.updateOption(id, optionId, body, user);
    }

    @Delete(':id/options/:option_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('SERVICE_NOT_FOUND', 'OPTION_NOT_FOUND', 'OPTION_HAS_BOOKINGS')
    async removeOption(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @CurrentUser() user: AuthUser,
    ): Promise<void> {
        await this.services.removeOption(id, optionId, user);
    }

    @Put(':id/options/:option_id/recurrence')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND', 'OPTION_NOT_FOUND')
    @Serialize(serviceResponseSchema)
    setRecurrence(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Body() body: RecurrenceDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
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
    @ApiErrors('SERVICE_NOT_FOUND', 'OPTION_NOT_FOUND', 'CONFLICT')
    @Serialize(serviceResponseSchema)
    addSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Body() body: unknown,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
        return this.services.addSlot(id, optionId, parseBody(createSlotSchema, body), user);
    }

    @Patch(':id/options/:option_id/slots/:slot_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiData(ServiceResponseDto)
    @ApiErrors(
        'SERVICE_NOT_FOUND',
        'OPTION_NOT_FOUND',
        'SLOT_NOT_FOUND',
        'SLOT_NOT_DATED',
        'SLOT_NOT_LIMITED',
        'SLOT_NOT_TIMED',
        'SLOT_TIME_BOOKED',
    )
    @Serialize(serviceResponseSchema)
    updateSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Param('slot_id') slotId: string,
        @Body() body: UpdateSlotDto,
        @CurrentUser() user: AuthUser,
    ): Promise<ServiceTreeEntity> {
        return this.services.updateSlot(id, optionId, slotId, body, user);
    }

    @Delete(':id/options/:option_id/slots/:slot_id')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiErrors('SERVICE_NOT_FOUND', 'OPTION_NOT_FOUND', 'SLOT_NOT_FOUND', 'SLOT_HAS_BOOKINGS')
    async removeSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Param('slot_id') slotId: string,
        @CurrentUser() user: AuthUser,
    ): Promise<void> {
        await this.services.removeSlot(id, optionId, slotId, user);
    }

    @Post(':id/options/:option_id/slots/:slot_id/cancel')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.OK)
    @ApiData(CloseSlotResponseDto)
    @ApiErrors(
        'SERVICE_NOT_FOUND',
        'OPTION_NOT_FOUND',
        'SLOT_NOT_FOUND',
        'SLOT_NOT_BOOKABLE',
        'SLOT_NOT_TIMED',
        'SLOT_BULK_TOO_LARGE',
        'IDEMPOTENCY_IN_PROGRESS',
        'IDEMPOTENCY_KEY_REUSED',
    )
    @Serialize(closeSlotResponseSchema)
    closeSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Param('slot_id') slotId: string,
        @Body() body: CloseSlotDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
        @Headers('idempotency-key') idempotencyKey?: string,
    ): Promise<CloseSlotResult> {
        return this.replayable(
            this.slots.close(id, optionId, slotId, body, user, parseIdempotencyKey(idempotencyKey)),
            res,
        );
    }

    @Post(':id/options/:option_id/slots/:slot_id/move')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @HttpCode(HttpStatus.OK)
    @ApiData(MoveSlotResponseDto)
    @ApiErrors(
        'SERVICE_NOT_FOUND',
        'OPTION_NOT_FOUND',
        'SLOT_NOT_FOUND',
        'SLOT_NOT_DATED',
        'SLOT_NOT_TIMED',
        'SLOT_EXPIRED',
        'SLOT_DATE_TAKEN',
        'SLOT_TIME_OUT_OF_RANGE',
        'SLOT_BULK_TOO_LARGE',
        'IDEMPOTENCY_IN_PROGRESS',
        'IDEMPOTENCY_KEY_REUSED',
    )
    @Serialize(moveSlotResponseSchema)
    moveSlot(
        @Param('id') id: string,
        @Param('option_id') optionId: string,
        @Param('slot_id') slotId: string,
        @Body() body: MoveSlotDto,
        @CurrentUser() user: AuthUser,
        @Res({ passthrough: true }) res: Response,
        @Headers('idempotency-key') idempotencyKey?: string,
    ): Promise<MoveSlotResult> {
        return this.replayable(
            this.slots.move(id, optionId, slotId, body, user, parseIdempotencyKey(idempotencyKey)),
            res,
        );
    }

    private async replayable<T>(work: Promise<{ result: T; replayed: boolean }>, res: Response): Promise<T> {
        const { result, replayed } = await work;

        if (replayed) res.setHeader('Idempotency-Replayed', 'true');

        return result;
    }

    /** Authenticated, any role: a booking always belongs to the calling user. */
    @Post(':id/bookings')
    @ApiBearerAuth()
    @ApiCreatedResponse({ type: BookingCreatedResponseDto })
    @ApiErrors(...BOOKING_ERRORS)
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
    @ApiErrors('BOOKING_NOT_FOUND', 'BOOKING_NOT_ACTIVE', 'BOOKING_CANCEL_DEADLINE_PASSED')
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

    @Post(':id/waitlist')
    @ApiBearerAuth()
    @ApiCreatedResponse({ type: WaitlistEntryResponseDto })
    @ApiErrors(
        'SERVICE_NOT_FOUND',
        'SLOT_NOT_FOUND',
        'OPTION_DISABLED',
        'SLOT_NOT_BOOKABLE',
        'SLOT_EXPIRED',
        'SLOT_TIME_REQUIRED',
        'SLOT_NOT_FULL',
        'SERVICE_NOT_PUBLISHED',
        'ORGANIZATION_CLOSED',
        'WAITLIST_ALREADY_JOINED',
    )
    @Serialize(waitlistEntryResponseSchema)
    joinWaitlist(
        @Param('id') id: string,
        @Body() body: JoinWaitlistDto,
        @CurrentUser() user: AuthUser,
    ): Promise<WaitlistEntryResource> {
        return this.bookings.joinWaitlist(id, body, user);
    }

    @Get(':id/waitlist')
    @ApiBearerAuth()
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'service' })
    @ApiPaginated(WaitlistEntryResponseDto)
    @ApiErrors('SERVICE_NOT_FOUND')
    @SerializePaginated(waitlistEntryResponseSchema)
    waitlistForService(
        @Param('id') id: string,
        @Query() query: ListWaitlistQueryDto,
    ): Promise<PaginatedResult<WaitlistEntryResource>> {
        return this.bookings.listWaitlistForService(id, query);
    }
}
