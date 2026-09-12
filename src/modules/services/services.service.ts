import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type ClientSession, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { BookingsRepository } from '../bookings/bookings.repository';
import { CategoriesService } from '../categories/categories.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type CreateServiceInput,
    type ListServicesQuery,
    type RecurrenceInput,
    type ServiceOptionInput,
    type SlotInput,
    type UpdateOptionInput,
    type UpdateServiceInput,
    type UpdateSlotInput,
} from './dto/service.schemas';
import { type RecurrentDate, type Slot, type TimeEntry } from './schemas/service.schema';
import { ServicesMasker } from './services.masker';
import { type ServiceEntity, ServicesRepository } from './services.repository';
import {
    attachBookings,
    mergeBookings,
    optionFromInput,
    type RecurrentSlotPlan,
    slotFromInput,
} from './slot.logic';

const SERVICE_SORTABLE = ['position', 'created_at', 'label'] as const;

@Injectable()
export class ServicesService implements OnModuleInit {
    constructor(
        private readonly services: ServicesRepository,
        private readonly bookings: BookingsRepository,
        private readonly organizations: OrganizationsService,
        private readonly categories: CategoriesService,
        private readonly masker: ServicesMasker,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
    ) {}

    onModuleInit(): void {
        this.scopes.register('service', async (id) => {
            const service = await this.services.findById(id);

            return service ? { ...service, organization_id: service.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'services.delete', async (organizationId, ctx) => {
            await this.services.deleteByOrganization(organizationId, ctx.session);
        });
        this.cascade.register('category', 'services.delete', async (categoryId, ctx) => {
            const services = await this.services.findByCategory(categoryId, ctx.session);

            for (const service of services) await this.cascade.run('service', service._id.toHexString(), ctx);

            await this.services.deleteByCategory(categoryId, ctx.session);
        });
    }

    async list(query: ListServicesQuery, viewer?: AuthUser): Promise<PaginatedResult<ServiceEntity>> {
        const scoped = Boolean(query.organization_id || query.category_id);
        const pagination = this.pagination.resolve(query, {
            sortable: SERVICE_SORTABLE,
            defaultSort: scoped ? 'position' : 'created_at',
            defaultOrder: scoped ? 'asc' : 'desc',
        });
        const filter: Record<string, unknown> = {};

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.category_id) filter['category_id'] = new Types.ObjectId(query.category_id);

        if (query.enabled !== undefined) filter['enabled'] = query.enabled;

        const result = await this.services.paginate(filter, pagination);

        return { ...result, items: await this.present(result.items, viewer) };
    }

    async getById(id: string): Promise<ServiceEntity> {
        const service = await this.services.findById(id);

        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return service;
    }

    async getMasked(id: string, viewer?: AuthUser): Promise<ServiceEntity> {
        const [service] = await this.present([await this.getById(id)], viewer);

        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return service;
    }

    async create(input: CreateServiceInput, viewer?: AuthUser): Promise<ServiceEntity> {
        await this.organizations.assertExists(input.organization_id);
        const categoryId = input.category_id ?? null;

        if (categoryId) await this.categories.assertBelongsTo(categoryId, input.organization_id);

        const position = await this.services.nextPosition(input.organization_id, categoryId);
        const created = await this.services.create({
            organization_id: new Types.ObjectId(input.organization_id),
            category_id: categoryId ? new Types.ObjectId(categoryId) : null,
            position,
            label: input.label ?? texts.defaults.serviceLabel,
            enabled: input.enabled ?? false,
            value: input.value ?? {},
            options: (input.options ?? []).map(optionFromInput),
        });

        return this.presented(created, viewer);
    }

    /**
     * Updates the service's own fields; replacing `options` keeps existing occupancy by id. That is a
     * read-modify-write of the whole array, so it runs in a transaction — a booking committed in between
     * makes the write conflict and retry instead of being silently dropped. The sub-resource routes
     * below change one option or slot without touching the rest of the array.
     */
    async update(id: string, input: UpdateServiceInput, viewer?: AuthUser): Promise<ServiceEntity> {
        const updated =
            input.options === undefined
                ? await this.applyUpdate(id, input)
                : await this.tx.run((ctx) => this.applyUpdate(id, input, ctx.session));

        return this.presented(updated, viewer);
    }

    private async applyUpdate(
        id: string,
        input: UpdateServiceInput,
        session?: ClientSession,
    ): Promise<ServiceEntity> {
        const existing = await this.services.findById(id, session);

        if (!existing) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const set: Record<string, unknown> = {};

        if (input.category_id !== undefined) {
            const organizationId = existing.organization_id.toHexString();

            if (input.category_id) await this.categories.assertBelongsTo(input.category_id, organizationId);

            const nextCategory = input.category_id ? new Types.ObjectId(input.category_id) : null;
            const currentCategory = existing.category_id ? existing.category_id.toHexString() : null;

            if ((nextCategory ? nextCategory.toHexString() : null) !== currentCategory) {
                set['category_id'] = nextCategory;
                set['position'] = await this.services.nextPosition(
                    organizationId,
                    input.category_id ?? null,
                    session,
                );
            }
        }

        if (input.label !== undefined) set['label'] = input.label;

        if (input.enabled !== undefined) set['enabled'] = input.enabled;

        if (input.value !== undefined) set['value'] = input.value;

        if (input.options !== undefined) {
            set['options'] = mergeBookings(existing.options, input.options.map(optionFromInput));
        }

        const updated = Object.keys(set).length
            ? await this.services.updateById(id, { $set: set }, session)
            : existing;

        if (!updated) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return updated;
    }

    async delete(id: string): Promise<void> {
        await this.getById(id);
        await this.tx.run(async (ctx) => {
            await this.cascade.run('service', id, ctx);
            await this.services.deleteById(id, ctx.session);
        });
    }

    async reorderDirect(organizationId: string, ids: string[]): Promise<void> {
        await this.tx.run(({ session }) => this.services.reorderDirect(organizationId, ids, session));
    }

    async reorderInCategory(categoryId: string, ids: string[]): Promise<void> {
        await this.categories.getById(categoryId);
        await this.tx.run(({ session }) => this.services.reorderInCategory(categoryId, ids, session));
    }

    // ----- options and slots as sub-resources -----

    /**
     * Every sub-resource write validates against the stored document inside a transaction and then
     * writes with `arrayFilters`, so a concurrent booking of a neighbouring slot is never overwritten.
     */
    async addOption(id: string, input: ServiceOptionInput, viewer?: AuthUser): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            await this.load(id, ctx.session);
            await this.services.pushOption(id, optionFromInput(input), ctx.session);

            return this.load(id, ctx.session);
        });

        return this.presented(service, viewer);
    }

    async updateOption(
        id: string,
        optionId: string,
        input: UpdateOptionInput,
        viewer?: AuthUser,
    ): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const service = await this.load(id, ctx.session);
            this.optionOf(service, optionId);
            const fields: Record<string, unknown> = {};

            if (input.label !== undefined) fields['label'] = input.label;

            if (input.service_type !== undefined) fields['service_type'] = input.service_type;

            if (input.enabled !== undefined) fields['enabled'] = input.enabled;

            if (Object.keys(fields).length > 0)
                await this.services.setOptionFields(id, optionId, fields, ctx.session);

            return this.load(id, ctx.session);
        });

        return this.presented(service, viewer);
    }

    removeOption(id: string, optionId: string): Promise<void> {
        return this.tx.run(async (ctx) => {
            const service = await this.load(id, ctx.session);
            this.optionOf(service, optionId);

            if ((await this.bookings.countByOption(id, optionId, ctx.session)) > 0)
                throw ApiError.conflict('OPTION_HAS_BOOKINGS');

            await this.services.pullOption(id, optionId, ctx.session);
        });
    }

    async setRecurrence(
        id: string,
        optionId: string,
        input: RecurrenceInput,
        viewer?: AuthUser,
    ): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const service = await this.load(id, ctx.session);
            this.optionOf(service, optionId);
            const dates: RecurrentDate[] | null =
                input.recurrent_dates === null
                    ? null
                    : input.recurrent_dates.map((entry) => ({
                          day: entry.day,
                          time: entry.time.map((time) => ({ time: time.time, limit: time.limit ?? null })),
                      }));
            await this.services.setRecurrence(id, optionId, dates, ctx.session);

            return this.load(id, ctx.session);
        });

        return this.presented(service, viewer);
    }

    async addSlot(id: string, optionId: string, input: SlotInput, viewer?: AuthUser): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const service = await this.load(id, ctx.session);
            const option = this.optionOf(service, optionId);
            const slot = slotFromInput(input);

            if (option.slots.some((item) => item.id === slot.id)) throw ApiError.conflict('CONFLICT');

            await this.services.pushSlot(id, optionId, slot, ctx.session);

            return this.load(id, ctx.session);
        });

        return this.presented(service, viewer);
    }

    /**
     * Label, date and capacity of one slot. A time entry that already holds bookings can be neither
     * removed nor renamed — that is what a whole-array replacement could not promise.
     */
    async updateSlot(
        id: string,
        optionId: string,
        slotId: string,
        input: UpdateSlotInput,
        viewer?: AuthUser,
    ): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const service = await this.load(id, ctx.session);
            const slot = this.slotOf(this.optionOf(service, optionId), slotId);
            const fields: Record<string, unknown> = {};

            if (input.label !== undefined) fields['label'] = input.label;

            if (input.date !== undefined) {
                if (slot.child_type !== 'date_time' && slot.child_type !== 'date')
                    throw ApiError.unprocessable('SLOT_NOT_DATED');

                fields['value.date'] = input.date;
            }

            if (input.limit !== undefined) {
                if (slot.child_type !== 'date' && slot.child_type !== 'apply')
                    throw ApiError.unprocessable('SLOT_NOT_LIMITED');

                fields['value.limit'] = input.limit;
            }

            if (Object.keys(fields).length > 0)
                await this.services.setSlotFields(id, optionId, slotId, fields, ctx.session);

            if (input.time !== undefined) {
                if (slot.child_type !== 'date_time') throw ApiError.unprocessable('SLOT_NOT_TIMED');

                await this.applyTimes(id, optionId, slot, input.time, ctx.session);
            }

            return this.load(id, ctx.session);
        });

        return this.presented(service, viewer);
    }

    removeSlot(id: string, optionId: string, slotId: string): Promise<void> {
        return this.tx.run(async (ctx) => {
            const service = await this.load(id, ctx.session);
            this.slotOf(this.optionOf(service, optionId), slotId);

            if ((await this.bookings.countBySlot(id, optionId, slotId, ctx.session)) > 0)
                throw ApiError.conflict('SLOT_HAS_BOOKINGS');

            await this.services.pullSlots(id, optionId, [slotId], ctx.session);
        });
    }

    private async applyTimes(
        id: string,
        optionId: string,
        slot: Slot,
        input: { time: string; limit?: number | null }[],
        session: ClientSession,
    ): Promise<void> {
        const existing = slot.value.time ?? [];
        const requested = new Set(input.map((entry) => entry.time));
        const removed = existing.filter((entry) => !requested.has(entry.time)).map((entry) => entry.time);

        if (removed.length > 0) {
            const booked = await this.bookings.countByTimes(id, optionId, slot.id, removed, session);

            if (booked > 0) throw ApiError.conflict('SLOT_TIME_BOOKED');

            await this.services.pullTimes(id, optionId, slot.id, removed, session);
        }

        const added = input
            .filter((entry) => !existing.some((item) => item.time === entry.time))
            .map((entry): TimeEntry => ({ time: entry.time, limit: entry.limit ?? null, booked_count: 0 }));

        if (added.length > 0) await this.services.pushTimes(id, optionId, slot.id, added, session);

        for (const entry of input) {
            const previous = existing.find((item) => item.time === entry.time);

            if (!previous || entry.limit === undefined || previous.limit === entry.limit) continue;

            await this.services.setTimeLimit(id, optionId, slot.id, entry.time, entry.limit, session);
        }
    }

    private async load(id: string, session: ClientSession): Promise<ServiceEntity> {
        const service = await this.services.findById(id, session);

        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return service;
    }

    private optionOf(service: ServiceEntity, optionId: string) {
        const option = service.options.find((item) => item.id === optionId);

        if (!option) throw ApiError.notFound('OPTION_NOT_FOUND');

        return option;
    }

    private slotOf(option: { slots: Slot[] }, slotId: string): Slot {
        const slot = option.slots.find((item) => item.id === slotId);

        if (!slot) throw ApiError.notFound('SLOT_NOT_FOUND');

        return slot;
    }

    /**
     * Bookings are read only for viewers allowed to see them, and only for the services on the page;
     * everyone else gets occupancy markers rebuilt from `booked_count`, at no query cost.
     */
    private async presented(service: ServiceEntity, viewer?: AuthUser): Promise<ServiceEntity> {
        const [presented] = await this.present([service], viewer);

        if (!presented) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return presented;
    }

    private async present(services: ServiceEntity[], viewer?: AuthUser): Promise<ServiceEntity[]> {
        const privileged = services.filter((service) =>
            this.masker.canSeeDetails(viewer, service.organization_id.toHexString()),
        );
        const bookings = await this.bookings.findByServices(
            privileged.map((service) => service._id.toHexString()),
        );
        const byService = new Map<string, typeof bookings>();

        for (const booking of bookings) {
            const key = booking.service_id.toHexString();
            byService.set(key, [...(byService.get(key) ?? []), booking]);
        }

        return services.map((service) => {
            if (!this.masker.canSeeDetails(viewer, service.organization_id.toHexString()))
                return this.masker.maskCounts(service);

            return {
                ...service,
                options: attachBookings(service.options, byService.get(service._id.toHexString()) ?? []),
            };
        });
    }

    // ----- used by jobs -----

    findWithRecurrentOptions(): Promise<ServiceEntity[]> {
        return this.services.findWithRecurrentOptions();
    }

    findWithDatedSlots(): Promise<ServiceEntity[]> {
        return this.services.findWithDatedSlots();
    }

    findAllForDebtorReport(): Promise<ServiceEntity[]> {
        return this.services.findAllForDebtorReport();
    }

    /** Image URLs used by services; one of the sources `unreferenced_images` counts as a reference. */
    imageReferences(): Promise<string[]> {
        return this.services.imageReferences();
    }

    findAllSlotIds(): Promise<ServiceEntity[]> {
        return this.services.findAllSlotIds();
    }

    applyRecurrentPlans(
        plans: { id: string; option_id: string; plan: RecurrentSlotPlan }[],
        session?: ClientSession,
    ): Promise<number> {
        return this.services.applyRecurrentPlans(plans, session);
    }

    findForUpdate(id: string, session?: ClientSession): Promise<ServiceEntity | null> {
        return this.services.findById(id, session);
    }

    pullSlots(id: string, optionId: string, slotIds: string[], session?: ClientSession): Promise<boolean> {
        return this.services.pullSlots(id, optionId, slotIds, session);
    }
}
