import { Injectable } from '@nestjs/common';
import { type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { AppConfig } from '../../common/config/app-config';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { BookingsRepository } from '../bookings/bookings.repository';
import { type ServiceOption } from '../services/schemas/service.schema';
import { attachBookings, growTrees } from '../services/slot.logic';
import { ServicesMasker } from '../services/services.masker';
import { SlotsRepository } from '../slots/slots.repository';
import {
    type CreateOrganizationInput,
    type ListOrganizationsQuery,
    type NearbyOrganizationsQuery,
    type UpdateOrganizationInput,
} from './dto/organization.schemas';
import {
    type OrganizationEntity,
    type OrganizationListRow,
    OrganizationsRepository,
} from './organizations.repository';
import { type Organization } from './schemas/organization.schema';

const ORGANIZATION_SORTABLE = ['created_at', 'main_label', 'main_category'] as const;

type ServiceRow = { _id: Types.ObjectId; organization_id: Types.ObjectId; options: ServiceOption[] };

export type ServiceCardRow = Record<string, unknown> & {
    _id: Types.ObjectId;
    category_id?: Types.ObjectId | null;
};

export interface OrganizationTree extends OrganizationEntity {
    news: unknown[];
    infosections: unknown[];
    categories: (Record<string, unknown> & { _id: Types.ObjectId; services: ServiceCardRow[] })[];
    services: ServiceCardRow[];
    images: unknown[];
}

@Injectable()
export class OrganizationsService {
    constructor(
        private readonly organizations: OrganizationsRepository,
        private readonly pagination: PaginationService,
        private readonly config: AppConfig,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly masker: ServicesMasker,
        private readonly bookings: BookingsRepository,
        private readonly slots: SlotsRepository,
    ) {}

    async list(
        query: ListOrganizationsQuery,
        viewer?: AuthUser,
    ): Promise<PaginatedResult<OrganizationListRow>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ORGANIZATION_SORTABLE,
            defaultSort: 'created_at',
        });
        const filter: FilterQuery<Organization> = {};

        if (query.main_category) filter['main_category'] = query.main_category;

        if (query.status) filter['status'] = query.status;

        if (query.q) filter['$text'] = { $search: query.q };

        const result = await this.organizations.list(filter, pagination, {
            empty: query.empty === true,
            include: query.include,
            includeLimit: this.config.pagination.includeMaxItems,
            viewer,
        });

        if (query.include.includes('services'))
            result.items = await this.presentServices(result.items, viewer);

        return result;
    }

    /** Bookings are read only for the organization's own admins — a public list issues no such query. */
    private async presentServices(
        rows: OrganizationListRow[],
        viewer?: AuthUser,
    ): Promise<OrganizationListRow[]> {
        const visible = rows.filter((row) => this.masker.canSeeDetails(viewer, row._id.toHexString()));
        const serviceIds = visible.flatMap((row) =>
            (row.services ?? []).map((service) => String((service as { _id: unknown })._id)),
        );
        const [bookings, slots] = await Promise.all([
            this.bookings.findActiveByServices(serviceIds),
            this.slots.findByServices(
                rows.flatMap((row) => (row.services ?? []).map((service) => (service as ServiceRow)._id)),
            ),
        ]);
        const byService = new Map<string, typeof bookings>();

        for (const booking of bookings) {
            const key = booking.service_id.toHexString();
            byService.set(key, [...(byService.get(key) ?? []), booking]);
        }

        return rows.map((row) => {
            const organizationId = row._id.toHexString();
            const privileged = this.masker.canSeeDetails(viewer, organizationId);

            return {
                ...row,
                services: growTrees((row.services as ServiceRow[] | undefined) ?? [], slots).map((view) => {
                    if (!privileged) return this.masker.maskCounts(view);

                    return {
                        ...view,
                        options: attachBookings(
                            view.options ?? [],
                            byService.get(view._id.toHexString()) ?? [],
                        ),
                    };
                }),
            };
        });
    }

    async getById(id: string): Promise<OrganizationEntity> {
        const organization = await this.organizations.findById(id);

        if (!organization) throw ApiError.notFound('ORGANIZATION_NOT_FOUND');

        return organization;
    }

    async getTree(id: string, viewer?: AuthUser): Promise<OrganizationTree> {
        const row = await this.organizations.findTree(id, this.config.pagination.includeMaxItems, viewer);

        if (!row) throw ApiError.notFound('ORGANIZATION_NOT_FOUND');

        const services = row.services as ServiceCardRow[];
        const byCategory = new Map<string, ServiceCardRow[]>();
        const direct: ServiceCardRow[] = [];

        for (const service of services) {
            const categoryId = service.category_id ? service.category_id.toHexString() : null;

            if (!categoryId) {
                direct.push(service);
                continue;
            }

            const bucket = byCategory.get(categoryId) ?? [];
            bucket.push(service);
            byCategory.set(categoryId, bucket);
        }

        const categories = (row.categories as (Record<string, unknown> & { _id: Types.ObjectId })[]).map(
            (category) => ({
                ...category,
                services: byCategory.get(category._id.toHexString()) ?? [],
            }),
        );

        return { ...row, categories, services: direct };
    }

    nearby(query: NearbyOrganizationsQuery): Promise<(OrganizationEntity & { distance_m: number })[]> {
        const filter: FilterQuery<Organization> = {};

        if (query.main_category) filter['main_category'] = query.main_category;

        return this.organizations.nearby(query.lng, query.lat, query.radius_m, query.limit, filter);
    }

    create(input: CreateOrganizationInput): Promise<OrganizationEntity> {
        const { location, closed_until: closedUntil, ...rest } = input;

        return this.organizations.create({
            ...rest,
            status: input.status ?? 'active',
            closed_until: closedUntil ? new Date(closedUntil) : null,
            location: location ? { type: 'Point', coordinates: [location.lng, location.lat] } : undefined,
            working_hours: input.working_hours ?? [],
            holidays: [...new Set(input.holidays ?? [])],
            timezone: input.timezone ?? this.config.jobs.timezone,
        });
    }

    async update(id: string, input: UpdateOrganizationInput): Promise<OrganizationEntity> {
        await this.getById(id);
        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};

        for (const [key, value] of Object.entries(input)) {
            if (value === undefined) continue;

            if (key === 'location') {
                if (value === null) unset[key] = 1;
                else {
                    const point = value as { lng: number; lat: number };
                    set[key] = { type: 'Point', coordinates: [point.lng, point.lat] };
                }

                continue;
            }

            if (key === 'closed_until') {
                set[key] = value === null ? null : new Date(value as string);
                continue;
            }

            if (key === 'holidays') {
                set[key] = [...new Set(value as string[])];
                continue;
            }

            if (value === null) unset[key] = 1;
            else set[key] = value;
        }

        const update: Record<string, unknown> = {};

        if (Object.keys(set).length) update['$set'] = set;

        if (Object.keys(unset).length) update['$unset'] = unset;

        const updated = Object.keys(update).length
            ? await this.organizations.updateById(id, update)
            : await this.getById(id);

        if (!updated) throw ApiError.notFound('ORGANIZATION_NOT_FOUND');

        return updated;
    }

    async delete(id: string): Promise<void> {
        await this.getById(id);
        await this.tx.run(async (ctx) => {
            await this.cascade.run('organization', id, ctx);
            await this.organizations.deleteById(id, ctx.session);
        });
    }

    async assertExists(id: string): Promise<void> {
        if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('ORGANIZATION_NOT_FOUND');

        if (!(await this.organizations.exists({ _id: new Types.ObjectId(id) }))) {
            throw ApiError.notFound('ORGANIZATION_NOT_FOUND');
        }
    }

    async assertAllExist(ids: string[]): Promise<void> {
        const unique = [...new Set(ids)];

        if (unique.length === 0) return;

        const found = await this.organizations.countExisting(unique);

        if (found !== unique.length) throw ApiError.notFound('ORGANIZATION_NOT_FOUND');
    }

    findManyByIds(ids: string[]): Promise<OrganizationEntity[]> {
        return this.organizations.findManyByIds([...new Set(ids)]);
    }

    findAllForReport(): Promise<OrganizationEntity[]> {
        return this.organizations.findAllForReport();
    }

    existingIds(ids: string[]): Promise<Set<string>> {
        return this.organizations.existingIds(ids);
    }

    /** Logo URLs in use; one of the sources `unreferenced_images` counts as a reference. */
    imageReferences(): Promise<string[]> {
        return this.organizations.imageReferences();
    }

    labels(): Promise<Map<string, string>> {
        return this.organizations.labels();
    }

    holidays(): Promise<Map<string, string[]>> {
        return this.organizations.holidays();
    }

    timezones(): Promise<Map<string, string>> {
        return this.organizations.timezones();
    }

    async timezoneOf(id: string): Promise<string> {
        return (await this.organizations.timezoneOf(id)) ?? this.config.jobs.timezone;
    }
}
