import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { type CategoryEntity, CategoriesRepository } from './categories.repository';
import { type Category } from './schemas/category.schema';
import {
    type CreateCategoryInput,
    type ListCategoriesQuery,
    type UpdateCategoryInput,
} from './dto/category.schemas';

const CATEGORY_SORTABLE = ['position', 'created_at', 'label'] as const;

@Injectable()
export class CategoriesService implements OnModuleInit {
    constructor(
        private readonly categories: CategoriesRepository,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
    ) {}

    onModuleInit(): void {
        this.scopes.register('category', async (id) => {
            const category = await this.categories.findById(id);

            return category ? { ...category, organization_id: category.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'categories.delete', async (organizationId, ctx) => {
            await this.categories.deleteByOrganization(organizationId, ctx.session);
        });
    }

    list(query: ListCategoriesQuery): Promise<PaginatedResult<CategoryEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: CATEGORY_SORTABLE,
            defaultSort: 'position',
            defaultOrder: 'asc',
        });
        const filter: FilterQuery<Category> = {};

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.enabled !== undefined) filter['enabled'] = query.enabled;

        return this.categories.paginate(filter, pagination);
    }

    async getById(id: string): Promise<CategoryEntity> {
        const category = await this.categories.findById(id);

        if (!category) throw ApiError.notFound('CATEGORY_NOT_FOUND');

        return category;
    }

    async create(input: CreateCategoryInput): Promise<CategoryEntity> {
        await this.organizations.assertExists(input.organization_id);
        const position = await this.categories.nextPosition(input.organization_id);

        return this.categories.create({
            organization_id: new Types.ObjectId(input.organization_id),
            position,
            label: input.label,
            description: input.description,
            enabled: input.enabled ?? false,
        });
    }

    async update(id: string, input: UpdateCategoryInput): Promise<CategoryEntity> {
        await this.getById(id);
        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};

        if (input.label !== undefined) set['label'] = input.label;

        if (input.enabled !== undefined) set['enabled'] = input.enabled;

        if (input.description !== undefined) {
            if (input.description === null) unset['description'] = 1;
            else set['description'] = input.description;
        }

        const update: Record<string, unknown> = {};

        if (Object.keys(set).length) update['$set'] = set;

        if (Object.keys(unset).length) update['$unset'] = unset;

        const updated = Object.keys(update).length
            ? await this.categories.updateById(id, update)
            : await this.getById(id);

        if (!updated) throw ApiError.notFound('CATEGORY_NOT_FOUND');

        return updated;
    }

    async delete(id: string): Promise<void> {
        await this.getById(id);
        await this.tx.run(async (ctx) => {
            await this.cascade.run('category', id, ctx);
            await this.categories.deleteById(id, ctx.session);
        });
    }

    async reorder(organizationId: string, ids: string[]): Promise<void> {
        await this.tx.run(({ session }) => this.categories.reorder(organizationId, ids, session));
    }

    /** Used by the services module to validate `category_id` against the service's organization. */
    async assertBelongsTo(categoryId: string, organizationId: string): Promise<void> {
        const category = await this.getById(categoryId);

        if (category.organization_id.toHexString() !== organizationId) {
            throw ApiError.unprocessable('CATEGORY_ORGANIZATION_MISMATCH');
        }
    }
}
