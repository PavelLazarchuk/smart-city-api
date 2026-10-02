import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { FAVORITES_MAX_PER_USER } from '../../common/config/constants';
import { isStaffOf } from '../../common/content/visibility';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { type ServiceEntity } from '../services/services.repository';
import { ServicesService } from '../services/services.service';
import { type FavoriteParams, type ListFavoritesQuery } from './dto/favorite.schemas';
import { type FavoriteEntity, FavoritesRepository } from './favorites.repository';

export interface FavoriteView {
    type: FavoriteEntity['type'];
    id: string;
    organization_id: Types.ObjectId;
    available: boolean;
    service?: (ServiceEntity & { options_count: number }) | null;
    organization?: unknown;
    created_at: Date;
}

@Injectable()
export class FavoritesService implements OnModuleInit {
    constructor(
        private readonly favorites: FavoritesRepository,
        private readonly services: ServicesService,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('user', 'favorites.delete', async (userId, ctx) => {
            await this.favorites.deleteByUser(userId, ctx.session);
        });
        this.cascade.register('service', 'favorites.delete', async (serviceId, ctx) => {
            await this.favorites.deleteByTarget('service', serviceId, ctx.session);
        });
        this.cascade.register('organization', 'favorites.delete', async (organizationId, ctx) => {
            await this.favorites.deleteByOrganization(organizationId, ctx.session);
        });
    }

    async add({ type, id }: FavoriteParams, actor: AuthUser): Promise<void> {
        const organizationId = await this.ownerOf(type, id, actor);

        if (
            !(await this.favorites.has(actor.id, type, id)) &&
            (await this.favorites.countByUser(actor.id)) >= FAVORITES_MAX_PER_USER
        )
            throw ApiError.unprocessable('FAVORITES_LIMIT_REACHED');

        await this.favorites.add(actor.id, type, id, organizationId);
    }

    async remove({ type, id }: FavoriteParams, actor: AuthUser): Promise<void> {
        await this.favorites.remove(actor.id, type, id);
    }

    async list(query: ListFavoritesQuery, actor: AuthUser): Promise<PaginatedResult<FavoriteView>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at'],
            defaultSort: 'created_at',
        });
        const result = await this.favorites.listByUser(actor.id, query.type, pagination);
        const targets = (type: FavoriteEntity['type']): string[] =>
            result.items.filter((item) => item.type === type).map((item) => item.target_id.toHexString());
        const [services, organizations] = await Promise.all([
            this.services.findManyByIds(targets('service')),
            this.organizations.findManyByIds(targets('organization')),
        ]);
        const serviceById = new Map(services.map((service) => [service._id.toHexString(), service]));
        const organizationById = new Map(
            organizations.map((organization) => [organization._id.toHexString(), organization]),
        );

        return {
            ...result,
            items: result.items.map((item) => {
                const id = item.target_id.toHexString();
                const base = {
                    type: item.type,
                    id,
                    organization_id: item.organization_id,
                    created_at: item.created_at,
                };

                if (item.type === 'organization') {
                    const organization = organizationById.get(id) ?? null;

                    return { ...base, available: organization !== null, organization };
                }

                const service = serviceById.get(id);
                const visible = service !== undefined && this.isVisible(service, actor);

                return {
                    ...base,
                    available: visible,
                    service: visible ? { ...service, options_count: service.options.length } : null,
                };
            }),
        };
    }

    private async ownerOf(
        type: FavoriteParams['type'],
        id: string,
        actor: AuthUser,
    ): Promise<Types.ObjectId> {
        if (type === 'organization') {
            const organization = await this.organizations.getById(id);

            return organization._id;
        }

        const service = await this.services.getById(id, { organization_id: 1, status: 1, deleted_at: 1 });

        if (!this.isVisible(service, actor)) throw ApiError.notFound('SERVICE_NOT_FOUND');

        return service.organization_id;
    }

    private isVisible(
        service: Pick<ServiceEntity, 'status' | 'deleted_at' | 'organization_id'>,
        actor: AuthUser,
    ) {
        if (service.deleted_at) return false;

        return service.status === 'published' || isStaffOf(actor, service.organization_id.toHexString());
    }
}
