import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type ClientSession, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { type ArchiveEntity, ArchivesRepository } from './archives.repository';
import { type CreateArchiveInput, type ListArchivesQuery } from './dto/archive.schemas';

@Injectable()
export class ArchivesService implements OnModuleInit {
    constructor(
        private readonly archives: ArchivesRepository,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
    ) {}

    onModuleInit(): void {
        this.scopes.register('archive', async (id) => {
            const archive = await this.archives.findById(id);

            return archive ? { ...archive, organization_id: archive.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'archives.delete', async (organizationId, ctx) => {
            await this.archives.deleteByOrganization(organizationId, ctx.session);
        });
        this.cascade.register('service', 'archives.delete', async (serviceId, ctx) => {
            await this.archives.deleteByService(serviceId, ctx.session);
        });
    }

    list(query: ListArchivesQuery, viewer: AuthUser): Promise<PaginatedResult<ArchiveEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'type'],
            defaultSort: 'created_at',
        });
        const filter: Record<string, unknown> = {};

        if (query.type) filter['type'] = query.type;

        if (viewer.role === ROLES.SUPER_ADMIN) {
            if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);
        } else {
            const allowed = viewer.organization_ids.map((id) => new Types.ObjectId(id));

            if (query.organization_id) {
                if (!viewer.organization_ids.includes(query.organization_id))
                    throw ApiError.forbidden('FORBIDDEN');

                filter['organization_id'] = new Types.ObjectId(query.organization_id);
            } else {
                filter['organization_id'] = { $in: allowed };
            }
        }

        return this.archives.paginate(filter, pagination);
    }

    async getById(id: string, viewer: AuthUser): Promise<ArchiveEntity> {
        const archive = await this.archives.findById(id);

        if (!archive) throw ApiError.notFound('ARCHIVE_NOT_FOUND');

        this.assertCanAccess(archive, viewer);

        return archive;
    }

    async create(input: CreateArchiveInput): Promise<ArchiveEntity> {
        await this.organizations.assertExists(input.organization_id);

        if (input.service_id) {
            const service = await this.scopes.resolve('service', input.service_id);

            if (!service) throw ApiError.notFound('SERVICE_NOT_FOUND');

            if (service.organization_id !== input.organization_id)
                throw ApiError.unprocessable('ARCHIVE_SERVICE_MISMATCH');
        }

        return this.archives.create({
            organization_id: new Types.ObjectId(input.organization_id),
            service_id: input.service_id ? new Types.ObjectId(input.service_id) : undefined,
            type: input.type,
            data: input.data,
        });
    }

    async delete(id: string, viewer: AuthUser): Promise<void> {
        await this.getById(id, viewer);
        await this.archives.deleteById(id);
    }

    /** Used by the expiry jobs inside their transactions. */
    createSnapshot(
        input: {
            organization_id: Types.ObjectId;
            service_id?: Types.ObjectId;
            type: 'news' | 'service';
            data: Record<string, unknown>;
        },
        session?: ClientSession,
    ): Promise<ArchiveEntity> {
        return this.archives.create(input, session);
    }

    private assertCanAccess(archive: ArchiveEntity, viewer: AuthUser): void {
        if (viewer.role === ROLES.SUPER_ADMIN) return;

        if (
            viewer.role === ROLES.COMMON_ADMIN &&
            viewer.organization_ids.includes(archive.organization_id.toHexString())
        )
            return;

        throw ApiError.forbidden('FORBIDDEN');
    }
}
