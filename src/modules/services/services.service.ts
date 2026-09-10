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
import { CategoriesService } from '../categories/categories.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type CreateServiceInput,
    type ListServicesQuery,
    type UpdateServiceInput,
} from './dto/service.schemas';
import { ServicesMasker } from './services.masker';
import { type ServiceEntity, ServicesRepository } from './services.repository';
import { mergeBookings, optionFromInput, type RecurrentSlotPlan } from './slot.logic';

const SERVICE_SORTABLE = ['position', 'created_at', 'label'] as const;

@Injectable()
export class ServicesService implements OnModuleInit {
    constructor(
        private readonly services: ServicesRepository,
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

        return { ...result, items: result.items.map((service) => this.masker.mask(service, viewer)) };
    }

    async getById(id: string): Promise<ServiceEntity> {
        const service = await this.services.findById(id);

        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return service;
    }

    async getMasked(id: string, viewer?: AuthUser): Promise<ServiceEntity> {
        return this.masker.mask(await this.getById(id), viewer);
    }

    async create(input: CreateServiceInput): Promise<ServiceEntity> {
        await this.organizations.assertExists(input.organization_id);
        const categoryId = input.category_id ?? null;

        if (categoryId) await this.categories.assertBelongsTo(categoryId, input.organization_id);

        const position = await this.services.nextPosition(input.organization_id, categoryId);

        return this.services.create({
            organization_id: new Types.ObjectId(input.organization_id),
            category_id: categoryId ? new Types.ObjectId(categoryId) : null,
            position,
            label: input.label ?? texts.defaults.serviceLabel,
            enabled: input.enabled ?? false,
            value: input.value ?? {},
            options: (input.options ?? []).map(optionFromInput),
        });
    }

    /**
     * Updates the service's own fields; replacing `options` keeps existing bookings by id. That is a
     * read-modify-write of the whole array, so it runs in a transaction — a booking committed in between
     * makes the write conflict and retry instead of being silently dropped.
     */
    async update(id: string, input: UpdateServiceInput): Promise<ServiceEntity> {
        if (input.options !== undefined)
            return this.tx.run((ctx) => this.applyUpdate(id, input, ctx.session));

        return this.applyUpdate(id, input);
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

    findAllBookingIds(): Promise<ServiceEntity[]> {
        return this.services.findAllBookingIds();
    }

    applyRecurrentPlans(
        plans: { id: string; option_id: string; plan: RecurrentSlotPlan }[],
        session?: ClientSession,
    ): Promise<number> {
        return this.services.applyRecurrentPlans(plans, session);
    }

    findWithBookingsOfUser(userId: string, session?: ClientSession): Promise<ServiceEntity[]> {
        return this.services.findWithBookingsOfUser(userId, session);
    }

    findForUpdate(id: string, session?: ClientSession): Promise<ServiceEntity | null> {
        return this.services.findById(id, session);
    }

    pullSlots(id: string, optionId: string, slotIds: string[], session?: ClientSession): Promise<boolean> {
        return this.services.pullSlots(id, optionId, slotIds, session);
    }
}
