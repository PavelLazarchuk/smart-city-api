import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type ClientSession, type FilterQuery, type ProjectionType, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { AppConfig } from '../../common/config/app-config';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { slugify, uniqueSlug } from '../../common/slug';
import { BookingsRepository } from '../bookings/bookings.repository';
import { CategoriesService } from '../categories/categories.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type AvailabilityQuery,
    type AvailabilityResponse,
    type CreateServiceInput,
    type GetServiceQuery,
    type ListServicesQuery,
    type NearbyQuery,
    type RecurrenceInput,
    type ServiceInclude,
    type ServiceOptionInput,
    type SlotInput,
    type UpdateOptionInput,
    type UpdateServiceInput,
    type UpdateSlotInput,
} from './dto/service.schemas';
import { type RevisionAction } from './schemas/service-revision.schema';
import {
    BOOKABLE_SLOT_TYPES,
    type BookingPolicy,
    type RecurrentDate,
    type Service,
    type ServiceStatus,
    type Slot,
    type TimeEntry,
} from './schemas/service.schema';
import { type ServiceRevisionEntity, ServiceRevisionsRepository } from './service-revisions.repository';
import { ServicesMasker } from './services.masker';
import { type ServiceEntity, ServicesRepository } from './services.repository';
import {
    attachBookings,
    formatDateOnly,
    mergeBookings,
    optionFromInput,
    type RecurrentSlotPlan,
    slotFromInput,
} from './slot.logic';

const SERVICE_SORTABLE = ['position', 'created_at', 'label', 'price', 'published_at'] as const;
const REVISION_IGNORED = new Set(['updated_at', 'created_at', '_id']);

export type ServiceListItem = ServiceEntity & {
    distance_m?: number;
    organization?: unknown;
    category?: unknown;
};

function withoutCounters(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutCounters);

    if (value instanceof Types.ObjectId) return value.toHexString();

    if (value instanceof Date) return value.toISOString();

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([key]) => key !== 'booked_count')
                .map(([key, item]) => [key, withoutCounters(item)]),
        );
    }

    return value;
}

export function diffTopLevel(
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
): Record<string, { before: unknown; after: unknown }> {
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

    for (const key of keys) {
        if (REVISION_IGNORED.has(key)) continue;

        const left = withoutCounters(before?.[key]);
        const right = withoutCounters(after?.[key]);

        if (JSON.stringify(left) !== JSON.stringify(right)) changes[key] = { before: left, after: right };
    }

    return changes;
}

@Injectable()
export class ServicesService implements OnModuleInit {
    constructor(
        private readonly services: ServicesRepository,
        private readonly revisions: ServiceRevisionsRepository,
        private readonly bookings: BookingsRepository,
        private readonly organizations: OrganizationsService,
        private readonly categories: CategoriesService,
        private readonly masker: ServicesMasker,
        private readonly config: AppConfig,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
    ) {}

    onModuleInit(): void {
        // The resolver sees the trash too: restoring or purging needs the organization of a deleted row.
        this.scopes.register('service', async (id) => {
            const service = await this.services.findById(id);

            return service ? { ...service, organization_id: service.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'services.delete', async (organizationId, ctx) => {
            await this.revisions.deleteByOrganization(organizationId, ctx.session);
            await this.services.deleteByOrganization(organizationId, ctx.session);
        });
        this.cascade.register('category', 'services.delete', async (categoryId, ctx) => {
            const services = await this.services.findByCategory(categoryId, ctx.session);

            for (const service of services) await this.cascade.run('service', service._id.toHexString(), ctx);

            await this.services.deleteByCategory(categoryId, ctx.session);
        });
        this.cascade.register('service', 'revisions.delete', async (serviceId, ctx) => {
            await this.revisions.deleteByService(serviceId, ctx.session);
        });
    }

    async list(query: ListServicesQuery, viewer?: AuthUser): Promise<PaginatedResult<ServiceListItem>> {
        const scoped = Boolean(query.organization_id || query.category_id);
        const pagination = this.pagination.resolve(query, {
            sortable: SERVICE_SORTABLE,
            defaultSort: scoped ? 'position' : 'created_at',
            defaultOrder: scoped ? 'asc' : 'desc',
        });
        const filter = this.visibilityFilter(viewer, query.deleted === true);

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.category_id) filter['category_id'] = new Types.ObjectId(query.category_id);

        if (query.enabled !== undefined) filter['enabled'] = query.enabled;

        if (query.status !== undefined && this.masker.maySeeDetails(viewer)) filter['status'] = query.status;

        if (query.tags.length > 0) filter['tags'] = { $in: query.tags };

        const projection = this.projectionFor(viewer);
        const result = query.q
            ? await this.services.searchText(filter, query.q, pagination, projection)
            : await this.services.paginate(filter, pagination, projection);
        const items = await this.present(result.items, viewer);

        return { ...result, items: await this.attachIncludes(items, query.include) };
    }

    async nearby(query: NearbyQuery, viewer?: AuthUser): Promise<ServiceListItem[]> {
        const filter = this.visibilityFilter(viewer, false);

        if (query.tags.length > 0) filter['tags'] = { $in: query.tags };

        const projection = this.projectionFor(viewer);
        const rows = await this.services.nearby(
            query.lng,
            query.lat,
            query.radius_m,
            query.limit,
            filter,
            projection as Record<string, 0 | 1> | undefined,
        );
        const items = await this.present(rows, viewer);

        return this.attachIncludes(items, query.include);
    }

    async getById(id: string, projection?: ProjectionType<Service>): Promise<ServiceEntity> {
        const service = await this.services.findById(id, undefined, projection);

        if (!service || service.deleted_at) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return service;
    }

    async getMasked(id: string, viewer?: AuthUser, query?: GetServiceQuery): Promise<ServiceListItem> {
        const service = await this.getById(id, this.projectionFor(viewer));

        if (
            service.status !== 'published' &&
            !this.masker.canSeeDetails(viewer, service.organization_id.toHexString())
        )
            throw ApiError.notFound('SERVICE_NOT_FOUND');

        const [presented] = await this.attachIncludes(
            await this.present([service], viewer),
            query?.include ?? [],
        );

        if (!presented) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return presented;
    }

    async getBySlug(organizationId: string, slug: string, viewer?: AuthUser, query?: GetServiceQuery) {
        const service = await this.services.findBySlug(organizationId, slug, this.projectionFor(viewer));

        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return this.getMasked(service._id.toHexString(), viewer, query);
    }

    private visibilityFilter(viewer: AuthUser | undefined, trash: boolean): FilterQuery<Service> {
        if (viewer?.role === ROLES.SUPER_ADMIN)
            return trash ? { deleted_at: { $ne: null } } : { deleted_at: null };

        if (viewer?.role === ROLES.COMMON_ADMIN) {
            const own = viewer.organization_ids.map((id) => new Types.ObjectId(id));

            if (trash) return { deleted_at: { $ne: null }, organization_id: { $in: own } };

            return { deleted_at: null, $or: [{ status: 'published' }, { organization_id: { $in: own } }] };
        }

        return { deleted_at: null, status: 'published' };
    }

    private projectionFor(viewer?: AuthUser): ProjectionType<Service> | undefined {
        return this.masker.maySeeDetails(viewer) ? undefined : { 'value.subscribe': 0 };
    }

    private async attachIncludes(
        items: ServiceListItem[],
        include: ServiceInclude[],
    ): Promise<ServiceListItem[]> {
        if (include.length === 0 || items.length === 0) return items;

        const [organizations, categories] = await Promise.all([
            include.includes('organization')
                ? this.organizations.findManyByIds(items.map((item) => item.organization_id.toHexString()))
                : Promise.resolve([]),
            include.includes('category')
                ? this.categories.findManyByIds(
                      items.flatMap((item) => (item.category_id ? [item.category_id.toHexString()] : [])),
                  )
                : Promise.resolve([]),
        ]);
        const byOrganization = new Map(organizations.map((row) => [row._id.toHexString(), row]));
        const byCategory = new Map(categories.map((row) => [row._id.toHexString(), row]));

        return items.map((item) => ({
            ...item,
            ...(include.includes('organization')
                ? { organization: byOrganization.get(item.organization_id.toHexString()) }
                : {}),
            ...(include.includes('category')
                ? {
                      category: item.category_id
                          ? (byCategory.get(item.category_id.toHexString()) ?? null)
                          : null,
                  }
                : {}),
        }));
    }

    async availability(id: string, query: AvailabilityQuery): Promise<AvailabilityResponse> {
        const service = await this.getById(id, { 'value.subscribe': 0 });
        const from = query.from ?? formatDateOnly(new Date());
        const horizon = new Date();
        horizon.setDate(horizon.getDate() + this.config.retention.recurrentHorizonDays);
        const to = query.to ?? formatDateOnly(horizon);
        const free = (limit: number | null | undefined, booked: number): number | null =>
            limit === null || limit === undefined ? null : Math.max(0, limit - booked);
        const options = service.options
            .filter((option) => option.enabled)
            .map((option) => ({
                id: option.id,
                label: option.label,
                service_type: option.service_type,
                enabled: option.enabled,
                slots: option.slots
                    .filter((slot) => BOOKABLE_SLOT_TYPES.includes(slot.child_type))
                    .filter((slot) => {
                        const date = slot.value.date;

                        return typeof date !== 'string' || (date >= from && date <= to);
                    })
                    .map((slot) => {
                        const booked = slot.value.booked_count ?? 0;

                        return {
                            id: slot.id,
                            label: slot.label,
                            child_type: slot.child_type,
                            date: slot.value.date ?? null,
                            limit: slot.value.limit ?? null,
                            booked_count: booked,
                            available: free(slot.value.limit, booked),
                            ...(slot.value.time
                                ? {
                                      time: slot.value.time.map((entry) => ({
                                          time: entry.time,
                                          limit: entry.limit,
                                          booked_count: entry.booked_count,
                                          available: free(entry.limit, entry.booked_count),
                                      })),
                                  }
                                : {}),
                        };
                    }),
            }))
            .filter((option) => option.slots.length > 0);

        return {
            service_id: service._id.toHexString(),
            organization_id: service.organization_id.toHexString(),
            from,
            to,
            options,
        };
    }

    async create(input: CreateServiceInput, viewer?: AuthUser): Promise<ServiceEntity> {
        await this.organizations.assertExists(input.organization_id);
        const categoryId = input.category_id ?? null;

        if (categoryId) await this.categories.assertBelongsTo(categoryId, input.organization_id);

        const organizationId = new Types.ObjectId(input.organization_id);
        const status = this.statusOf(input.status, input.enabled, 'draft');
        const label = input.label ?? texts.defaults.serviceLabel;
        const slug = await this.resolveSlug(organizationId, input.slug, label);
        const position = await this.services.nextPosition(input.organization_id, categoryId);
        // `null` means "absent" on creation; only an update needs it as an explicit `$unset`.
        const fields = Object.fromEntries(
            Object.entries(this.descriptiveFields(input)).filter(
                ([key, value]) =>
                    !(value === null && (key === 'location' || key === 'address' || key === 'description')),
            ),
        );
        const created = await this.services.create({
            organization_id: organizationId,
            category_id: categoryId ? new Types.ObjectId(categoryId) : null,
            position,
            label,
            slug,
            status,
            enabled: status === 'published',
            published_at: status === 'published' ? new Date() : null,
            value: input.value ?? {},
            options: (input.options ?? []).map(optionFromInput),
            ...fields,
        });
        await this.record(created, 'create', null, created, viewer);

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
                ? await this.applyUpdate(id, input, viewer)
                : await this.tx.run((ctx) => this.applyUpdate(id, input, viewer, ctx.session));

        return this.presented(updated, viewer);
    }

    private async applyUpdate(
        id: string,
        input: UpdateServiceInput,
        viewer?: AuthUser,
        session?: ClientSession,
    ): Promise<ServiceEntity> {
        const existing = await this.services.findById(id, session);

        if (!existing || existing.deleted_at) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};

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

        if (input.slug !== undefined) {
            if (await this.services.slugTaken(existing.organization_id, input.slug, id, session))
                throw ApiError.conflict('SERVICE_SLUG_TAKEN');

            set['slug'] = input.slug;
        }

        if (input.status !== undefined || input.enabled !== undefined) {
            const status = this.statusOf(input.status, input.enabled, existing.status);

            if (status !== existing.status) {
                set['status'] = status;
                set['enabled'] = status === 'published';

                if (status === 'published' && !existing.published_at) set['published_at'] = new Date();
            }
        }

        if (input.value !== undefined) set['value'] = input.value;

        if (input.options !== undefined) {
            set['options'] = mergeBookings(existing.options, input.options.map(optionFromInput));
        }

        for (const [key, value] of Object.entries(this.descriptiveFields(input))) {
            if (value === undefined) continue;

            if (value === null && (key === 'location' || key === 'description' || key === 'address'))
                unset[key] = 1;
            else set[key] = value;
        }

        const update: Record<string, unknown> = {};

        if (Object.keys(set).length) update['$set'] = set;

        if (Object.keys(unset).length) update['$unset'] = unset;

        const updated = Object.keys(update).length
            ? await this.services.updateById(id, update, session)
            : existing;

        if (!updated) throw ApiError.notFound('SERVICE_NOT_FOUND');

        if (Object.keys(update).length)
            await this.record(updated, 'update', existing, updated, viewer, session);

        return updated;
    }

    async setStatus(id: string, status: ServiceStatus, viewer?: AuthUser): Promise<ServiceEntity> {
        return this.update(id, { status }, viewer);
    }

    async delete(id: string, viewer?: AuthUser, permanent = false): Promise<void> {
        const existing = await this.services.findById(id);

        if (!existing) throw ApiError.notFound('SERVICE_NOT_FOUND');

        if (permanent) {
            await this.purge(id);

            return;
        }

        if (existing.deleted_at) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const deleted = await this.services.updateById(id, { $set: { deleted_at: new Date() } });

        if (!deleted) throw ApiError.notFound('SERVICE_NOT_FOUND');

        await this.record(deleted, 'delete', existing, deleted, viewer);
    }

    async restore(id: string, viewer?: AuthUser): Promise<ServiceEntity> {
        const existing = await this.services.findById(id);

        if (!existing) throw ApiError.notFound('SERVICE_NOT_FOUND');

        if (!existing.deleted_at) throw ApiError.unprocessable('SERVICE_NOT_DELETED');

        const restored = await this.services.updateById(id, { $set: { deleted_at: null } });

        if (!restored) throw ApiError.notFound('SERVICE_NOT_FOUND');

        await this.record(restored, 'restore', existing, restored, viewer);

        return this.presented(restored, viewer);
    }

    async purge(id: string): Promise<void> {
        await this.tx.run(async (ctx) => {
            await this.cascade.run('service', id, ctx);
            await this.services.deleteById(id, ctx.session);
        });
    }

    async purgeTrash(before: Date, limit = 100): Promise<number> {
        const rows = await this.services.findDeletedBefore(before, limit);

        for (const row of rows) await this.purge(row._id.toHexString());

        return rows.length;
    }

    listDeleted(query: ListServicesQuery, viewer: AuthUser): Promise<PaginatedResult<ServiceListItem>> {
        return this.list({ ...query, deleted: true }, viewer);
    }

    async history(
        id: string,
        query: { page?: number; limit?: number },
    ): Promise<PaginatedResult<ServiceRevisionEntity>> {
        const service = await this.services.findById(id);

        if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at'],
            defaultSort: 'created_at',
        });

        return this.revisions.listByService(id, pagination);
    }

    async reorderDirect(organizationId: string, ids: string[]): Promise<void> {
        await this.tx.run(({ session }) => this.services.reorderDirect(organizationId, ids, session));
    }

    async reorderInCategory(categoryId: string, ids: string[]): Promise<void> {
        await this.categories.getById(categoryId);
        await this.tx.run(({ session }) => this.services.reorderInCategory(categoryId, ids, session));
    }

    private statusOf(
        status: ServiceStatus | undefined,
        enabled: boolean | undefined,
        fallback: ServiceStatus,
    ): ServiceStatus {
        if (status !== undefined) return status;

        if (enabled === undefined) return fallback;

        return enabled ? 'published' : fallback === 'published' ? 'draft' : fallback;
    }

    private async resolveSlug(
        organizationId: Types.ObjectId,
        requested: string | undefined,
        label: string,
    ): Promise<string> {
        if (requested !== undefined) {
            if (await this.services.slugTaken(organizationId, requested))
                throw ApiError.conflict('SERVICE_SLUG_TAKEN');

            return requested;
        }

        return uniqueSlug(slugify(label), (candidate) => this.services.slugTaken(organizationId, candidate));
    }

    private descriptiveFields(input: Partial<UpdateServiceInput>): Record<string, unknown> {
        const fields: Record<string, unknown> = {};

        if (input.description !== undefined) fields['description'] = input.description;

        if (input.tags !== undefined) fields['tags'] = [...new Set(input.tags)];

        if (input.duration_minutes !== undefined) fields['duration_minutes'] = input.duration_minutes;

        if (input.buffer_minutes !== undefined) fields['buffer_minutes'] = input.buffer_minutes;

        if (input.price !== undefined) {
            fields['price'] = input.price;

            if (input.price !== null && input.currency === undefined)
                fields['currency'] = this.config.site.defaultCurrency;
        }

        if (input.currency !== undefined) fields['currency'] = input.currency;

        if (input.address !== undefined) fields['address'] = input.address;

        if (input.location !== undefined) {
            fields['location'] =
                input.location === null
                    ? null
                    : { type: 'Point', coordinates: [input.location.lng, input.location.lat] };
        }

        if (input.working_hours !== undefined) fields['working_hours'] = input.working_hours;

        if (input.holidays !== undefined) fields['holidays'] = [...new Set(input.holidays)];

        if (input.blackout_dates !== undefined) fields['blackout_dates'] = [...new Set(input.blackout_dates)];

        if (input.booking_policy !== undefined) {
            const policy: BookingPolicy = {
                max_active_per_user: input.booking_policy.max_active_per_user ?? null,
                lead_time_minutes: input.booking_policy.lead_time_minutes ?? null,
                max_advance_days: input.booking_policy.max_advance_days ?? null,
                cancel_deadline_minutes: input.booking_policy.cancel_deadline_minutes ?? null,
                requires_confirmation: input.booking_policy.requires_confirmation ?? false,
            };
            fields['booking_policy'] = policy;
        }

        if (input.form_fields !== undefined) {
            fields['form_fields'] = input.form_fields.map((field) => ({
                key: field.key,
                label: field.label,
                type: field.type,
                required: field.required ?? false,
                options: field.options,
                placeholder: field.placeholder,
                max_length: field.max_length ?? null,
            }));
        }

        if (input.required_documents !== undefined) {
            fields['required_documents'] = input.required_documents.map((document) => ({
                key: document.key,
                label: document.label,
                required: document.required ?? true,
            }));
        }

        return fields;
    }

    private async record(
        service: ServiceEntity,
        action: RevisionAction,
        before: ServiceEntity | null,
        after: ServiceEntity | null,
        viewer?: AuthUser,
        session?: ClientSession,
    ): Promise<void> {
        const changes = diffTopLevel(
            before as unknown as Record<string, unknown> | null,
            action === 'create'
                ? (after as unknown as Record<string, unknown>)
                : (after as unknown as Record<string, unknown> | null),
        );

        if (action === 'update' && Object.keys(changes).length === 0) return;

        await this.revisions.create(
            {
                service_id: service._id,
                organization_id: service.organization_id,
                action,
                actor_id: viewer ? new Types.ObjectId(viewer.id) : null,
                actor_role: viewer?.role ?? null,
                changes,
            },
            session,
        );
    }

    // ----- options and slots as sub-resources -----

    /**
     * Every sub-resource write validates against the stored document inside a transaction and then
     * writes with `arrayFilters`, so a concurrent booking of a neighbouring slot is never overwritten.
     */
    async addOption(id: string, input: ServiceOptionInput, viewer?: AuthUser): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const before = await this.load(id, ctx.session);
            await this.services.pushOption(id, optionFromInput(input), ctx.session);
            const after = await this.load(id, ctx.session);
            await this.record(after, 'option.add', before, after, viewer, ctx.session);

            return after;
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
            const before = await this.load(id, ctx.session);
            this.optionOf(before, optionId);
            const fields: Record<string, unknown> = {};

            if (input.label !== undefined) fields['label'] = input.label;

            if (input.service_type !== undefined) fields['service_type'] = input.service_type;

            if (input.enabled !== undefined) fields['enabled'] = input.enabled;

            if (Object.keys(fields).length > 0)
                await this.services.setOptionFields(id, optionId, fields, ctx.session);

            const after = await this.load(id, ctx.session);
            await this.record(after, 'option.update', before, after, viewer, ctx.session);

            return after;
        });

        return this.presented(service, viewer);
    }

    removeOption(id: string, optionId: string, viewer?: AuthUser): Promise<void> {
        return this.tx.run(async (ctx) => {
            const before = await this.load(id, ctx.session);
            this.optionOf(before, optionId);

            if ((await this.bookings.countActiveByOption(id, optionId, ctx.session)) > 0)
                throw ApiError.conflict('OPTION_HAS_BOOKINGS');

            await this.services.pullOption(id, optionId, ctx.session);
            const after = await this.load(id, ctx.session);
            await this.record(after, 'option.remove', before, after, viewer, ctx.session);
        });
    }

    async setRecurrence(
        id: string,
        optionId: string,
        input: RecurrenceInput,
        viewer?: AuthUser,
    ): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const before = await this.load(id, ctx.session);
            this.optionOf(before, optionId);
            const dates: RecurrentDate[] | null =
                input.recurrent_dates === null
                    ? null
                    : input.recurrent_dates.map((entry) => ({
                          day: entry.day,
                          time: entry.time.map((time) => ({ time: time.time, limit: time.limit ?? null })),
                          limit: entry.limit ?? null,
                      }));
            await this.services.setRecurrence(id, optionId, dates, ctx.session);
            const after = await this.load(id, ctx.session);
            await this.record(after, 'option.recurrence', before, after, viewer, ctx.session);

            return after;
        });

        return this.presented(service, viewer);
    }

    async addSlot(id: string, optionId: string, input: SlotInput, viewer?: AuthUser): Promise<ServiceEntity> {
        const service = await this.tx.run(async (ctx) => {
            const before = await this.load(id, ctx.session);
            const option = this.optionOf(before, optionId);
            const slot = slotFromInput(input);

            if (option.slots.some((item) => item.id === slot.id)) throw ApiError.conflict('CONFLICT');

            await this.services.pushSlot(id, optionId, slot, ctx.session);
            const after = await this.load(id, ctx.session);
            await this.record(after, 'slot.add', before, after, viewer, ctx.session);

            return after;
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
            const before = await this.load(id, ctx.session);
            const slot = this.slotOf(this.optionOf(before, optionId), slotId);
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

            const after = await this.load(id, ctx.session);
            await this.record(after, 'slot.update', before, after, viewer, ctx.session);

            return after;
        });

        return this.presented(service, viewer);
    }

    removeSlot(id: string, optionId: string, slotId: string, viewer?: AuthUser): Promise<void> {
        return this.tx.run(async (ctx) => {
            const before = await this.load(id, ctx.session);
            this.slotOf(this.optionOf(before, optionId), slotId);

            if ((await this.bookings.countActiveBySlot(id, optionId, slotId, ctx.session)) > 0)
                throw ApiError.conflict('SLOT_HAS_BOOKINGS');

            await this.services.pullSlots(id, optionId, [slotId], ctx.session);
            const after = await this.load(id, ctx.session);
            await this.record(after, 'slot.remove', before, after, viewer, ctx.session);
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
            const booked = await this.bookings.countActiveByTimes(id, optionId, slot.id, removed, session);

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

        if (!service || service.deleted_at) throw ApiError.notFound('SERVICE_NOT_FOUND');

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

    private async present<T extends ServiceEntity>(services: T[], viewer?: AuthUser): Promise<T[]> {
        const privileged = services.filter((service) =>
            this.masker.canSeeDetails(viewer, service.organization_id.toHexString()),
        );
        const bookings = await this.bookings.findActiveByServices(
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

    findManyByIds(ids: string[]): Promise<ServiceEntity[]> {
        return this.services.findManyByIds(ids);
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
