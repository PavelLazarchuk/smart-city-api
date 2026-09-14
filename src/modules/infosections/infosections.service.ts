import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type CreateInfoSectionInput,
    type ListInfoSectionsQuery,
    type UpdateInfoSectionInput,
} from './dto/infosection.schemas';
import { type InfoSectionEntity, InfoSectionsRepository } from './infosections.repository';
import { type InfoSection } from './schemas/infosection.schema';

const INFOSECTION_SORTABLE = ['position', 'created_at', 'label'] as const;

@Injectable()
export class InfoSectionsService implements OnModuleInit {
    constructor(
        private readonly infosections: InfoSectionsRepository,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
    ) {}

    onModuleInit(): void {
        this.scopes.register('infosection', async (id) => {
            const item = await this.infosections.findById(id);

            return item ? { ...item, organization_id: item.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'infosections.delete', async (organizationId, ctx) => {
            await this.infosections.deleteByOrganization(organizationId, ctx.session);
        });
    }

    list(query: ListInfoSectionsQuery): Promise<PaginatedResult<InfoSectionEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: INFOSECTION_SORTABLE,
            defaultSort: 'position',
            defaultOrder: 'asc',
        });
        const filter: FilterQuery<InfoSection> = {};

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.enabled !== undefined) filter['enabled'] = query.enabled;

        return this.infosections.paginate(filter, pagination);
    }

    async getById(id: string): Promise<InfoSectionEntity> {
        const item = await this.infosections.findById(id);

        if (!item) throw ApiError.notFound('INFOSECTION_NOT_FOUND');

        return item;
    }

    async create(input: CreateInfoSectionInput): Promise<InfoSectionEntity> {
        await this.organizations.assertExists(input.organization_id);
        const position = await this.infosections.nextPosition(input.organization_id);

        return this.infosections.create({
            organization_id: new Types.ObjectId(input.organization_id),
            position,
            label: input.label,
            enabled: input.enabled ?? false,
            control: input.control,
            value: input.value,
        });
    }

    async update(id: string, input: UpdateInfoSectionInput): Promise<InfoSectionEntity> {
        await this.getById(id);
        const set: Record<string, unknown> = {};

        if (input.label !== undefined) set['label'] = input.label;

        if (input.enabled !== undefined) set['enabled'] = input.enabled;

        if (input.control !== undefined && input.value !== undefined) {
            set['control'] = input.control;
            set['value'] = input.value;
        }

        const updated = Object.keys(set).length
            ? await this.infosections.updateById(id, { $set: set })
            : await this.getById(id);

        if (!updated) throw ApiError.notFound('INFOSECTION_NOT_FOUND');

        return updated;
    }

    async delete(id: string): Promise<void> {
        await this.getById(id);
        await this.infosections.deleteById(id);
    }

    async reorder(organizationId: string, ids: string[]): Promise<void> {
        await this.tx.run(({ session }) => this.infosections.reorder(organizationId, ids, session));
    }
}
