import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type ClientSession, type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { slugify, uniqueSlug } from '../../common/slug';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type CreateNewsInput,
    type ListNewsQuery,
    type RssQuery,
    type UpdateNewsInput,
} from './dto/news.schemas';
import { type NewsEntity, NewsRepository } from './news.repository';
import { type News } from './schemas/news.schema';

const NEWS_SORTABLE = ['position', 'date', 'created_at', 'label'] as const;

@Injectable()
export class NewsService implements OnModuleInit {
    constructor(
        private readonly news: NewsRepository,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
    ) {}

    onModuleInit(): void {
        this.scopes.register('news', async (id) => {
            const item = await this.news.findById(id);

            return item ? { ...item, organization_id: item.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'news.delete', async (organizationId, ctx) => {
            await this.news.deleteByOrganization(organizationId, ctx.session);
        });
    }

    list(query: ListNewsQuery, viewer?: AuthUser): Promise<PaginatedResult<NewsEntity>> {
        const scoped = Boolean(query.organization_id);
        const pagination = this.pagination.resolve(query, {
            sortable: NEWS_SORTABLE,
            defaultSort: scoped ? 'position' : 'date',
            defaultOrder: scoped ? 'asc' : 'desc',
        });
        const filter: FilterQuery<News> = this.scheduledFilter(viewer);

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.enabled !== undefined) filter['enabled'] = query.enabled;

        if (query.main) filter['is_main'] = true;

        if (query.offers) filter['is_offer'] = true;

        if (query.rubric) filter['rubric'] = query.rubric;

        return query.q
            ? this.news.searchText(filter, query.q, pagination)
            : this.news.paginate(filter, pagination);
    }

    private scheduledFilter(viewer?: AuthUser): FilterQuery<News> {
        if (viewer && viewer.role !== ROLES.COMMON_USER) return {};

        return { $or: [{ publish_at: null }, { publish_at: { $lte: new Date() } }] };
    }

    private isScheduled(item: NewsEntity, viewer?: AuthUser): boolean {
        if (viewer && viewer.role !== ROLES.COMMON_USER) return false;

        return (
            item.publish_at !== null &&
            item.publish_at !== undefined &&
            item.publish_at.getTime() > Date.now()
        );
    }

    async getById(id: string, viewer?: AuthUser): Promise<NewsEntity> {
        const item = await this.news.findById(id);

        if (!item || this.isScheduled(item, viewer)) throw ApiError.notFound('NEWS_NOT_FOUND');

        return item;
    }

    async getBySlug(organizationId: string, slug: string, viewer?: AuthUser): Promise<NewsEntity> {
        const item = await this.news.findBySlug(organizationId, slug);

        if (!item || this.isScheduled(item, viewer)) throw ApiError.notFound('NEWS_NOT_FOUND');

        return item;
    }

    feed(query: RssQuery): Promise<NewsEntity[]> {
        const filter: FilterQuery<News> = { enabled: true, ...this.scheduledFilter() };

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        if (query.rubric) filter['rubric'] = query.rubric;

        return this.news.feed(filter, query.limit);
    }

    async create(input: CreateNewsInput): Promise<NewsEntity> {
        await this.organizations.assertExists(input.organization_id);
        const organizationId = new Types.ObjectId(input.organization_id);
        const position = await this.news.nextPosition(input.organization_id);
        const slug = await this.resolveSlug(organizationId, input.slug, input.label);

        return this.news.create({
            organization_id: organizationId,
            position,
            label: input.label,
            slug,
            rubric: input.rubric ?? undefined,
            enabled: input.enabled ?? false,
            date: input.date ? new Date(input.date) : new Date(),
            publish_at: input.publish_at ? new Date(input.publish_at) : null,
            is_main: input.is_main ?? false,
            is_offer: input.is_offer ?? false,
            expires_at: input.expires_at ? new Date(input.expires_at) : undefined,
            value: input.value ?? {},
        });
    }

    private async resolveSlug(organizationId: Types.ObjectId, requested: string | undefined, label: string) {
        if (requested !== undefined) {
            if (await this.news.slugTaken(organizationId, requested))
                throw ApiError.conflict('NEWS_SLUG_TAKEN');

            return requested;
        }

        return uniqueSlug(slugify(label), (candidate) => this.news.slugTaken(organizationId, candidate));
    }

    private async loadForAdmin(id: string): Promise<NewsEntity> {
        const item = await this.news.findById(id);

        if (!item) throw ApiError.notFound('NEWS_NOT_FOUND');

        return item;
    }

    async update(id: string, input: UpdateNewsInput): Promise<NewsEntity> {
        const existing = await this.loadForAdmin(id);
        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};

        if (input.label !== undefined) set['label'] = input.label;

        if (input.slug !== undefined) {
            if (await this.news.slugTaken(existing.organization_id, input.slug, id))
                throw ApiError.conflict('NEWS_SLUG_TAKEN');

            set['slug'] = input.slug;
        }

        if (input.rubric !== undefined) {
            if (input.rubric === null) unset['rubric'] = 1;
            else set['rubric'] = input.rubric;
        }

        if (input.publish_at !== undefined)
            set['publish_at'] = input.publish_at ? new Date(input.publish_at) : null;

        if (input.enabled !== undefined) set['enabled'] = input.enabled;

        if (input.date !== undefined) set['date'] = new Date(input.date);

        if (input.is_main !== undefined) set['is_main'] = input.is_main;

        if (input.is_offer !== undefined) set['is_offer'] = input.is_offer;

        if (input.value !== undefined) set['value'] = input.value;

        if (input.expires_at !== undefined) {
            if (input.expires_at === null) unset['expires_at'] = 1;
            else set['expires_at'] = new Date(input.expires_at);
        }

        const update: Record<string, unknown> = {};

        if (Object.keys(set).length) update['$set'] = set;

        if (Object.keys(unset).length) update['$unset'] = unset;

        const updated = Object.keys(update).length ? await this.news.updateById(id, update) : existing;

        if (!updated) throw ApiError.notFound('NEWS_NOT_FOUND');

        return updated;
    }

    async delete(id: string): Promise<void> {
        await this.loadForAdmin(id);
        await this.news.deleteById(id);
    }

    async reorder(organizationId: string, ids: string[]): Promise<void> {
        await this.tx.run(({ session }) => this.news.reorder(organizationId, ids, session));
    }

    /** Image URLs used by news items; one of the sources `unreferenced_images` counts as a reference. */
    imageReferences(): Promise<string[]> {
        return this.news.imageReferences();
    }

    findExpired(now: Date, limit = 500): Promise<NewsEntity[]> {
        return this.news.findExpired(now, limit);
    }

    deleteExpired(id: string, ctx: { session: ClientSession }): Promise<boolean> {
        return this.news.deleteById(id, ctx.session);
    }
}
