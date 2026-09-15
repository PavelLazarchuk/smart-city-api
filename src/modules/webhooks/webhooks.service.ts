import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { type OutboxEventEntity, OutboxRepository } from '../../common/outbox/outbox.repository';
import { OutboxService } from '../../common/outbox/outbox.service';
import { type OutboxEvent } from '../../common/outbox/schemas/outbox-event.schema';
import { type Webhook } from '../../common/outbox/schemas/webhook.schema';
import { WebhookDeliveryService } from '../../common/outbox/webhook-delivery.service';
import { type WebhookEntity, WebhooksRepository } from '../../common/outbox/webhooks.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type CreateWebhookInput,
    type ListOutboxQuery,
    type ListWebhooksQuery,
    type UpdateWebhookInput,
} from './dto/webhook.schemas';

@Injectable()
export class WebhooksService implements OnModuleInit {
    constructor(
        private readonly webhooks: WebhooksRepository,
        private readonly outbox: OutboxService,
        private readonly events: OutboxRepository,
        private readonly delivery: WebhookDeliveryService,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('organization', 'webhooks.delete', async (organizationId, ctx) => {
            await this.webhooks.deleteByOrganization(organizationId, ctx.session);
        });
    }

    async list(query: ListWebhooksQuery, actor: AuthUser): Promise<PaginatedResult<WebhookEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'url'],
            defaultSort: 'created_at',
        });

        return this.webhooks.list(this.scope(query.organization_id, actor), pagination);
    }

    async getById(id: string, actor: AuthUser): Promise<WebhookEntity> {
        const webhook = await this.webhooks.findById(id);

        if (!webhook || !this.owns(webhook, actor)) throw ApiError.notFound('WEBHOOK_NOT_FOUND');

        return webhook;
    }

    async create(input: CreateWebhookInput, actor: AuthUser): Promise<WebhookEntity & { secret: string }> {
        const organizationId = input.organization_id ?? null;

        if (actor.role !== ROLES.SUPER_ADMIN) {
            if (!organizationId || !actor.organization_ids.includes(organizationId))
                throw ApiError.forbidden('FORBIDDEN');
        }

        if (organizationId) await this.organizations.assertExists(organizationId);

        this.assertUrl(input.url);
        const secret = WebhooksService.newSecret();
        const created = await this.webhooks.create({
            organization_id: organizationId ? new Types.ObjectId(organizationId) : null,
            url: input.url,
            secret,
            events: input.events,
            enabled: input.enabled ?? true,
            description: input.description,
            consecutive_failures: 0,
        });

        return { ...created, secret };
    }

    async update(id: string, input: UpdateWebhookInput, actor: AuthUser): Promise<WebhookEntity> {
        await this.getById(id, actor);
        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};

        if (input.url !== undefined) {
            this.assertUrl(input.url);
            set['url'] = input.url;
        }

        if (input.events !== undefined) set['events'] = input.events;

        if (input.enabled !== undefined) {
            set['enabled'] = input.enabled;

            if (input.enabled) set['consecutive_failures'] = 0;
        }

        if (input.description !== undefined) {
            if (input.description === null) unset['description'] = 1;
            else set['description'] = input.description;
        }

        const update: Record<string, unknown> = {};

        if (Object.keys(set).length) update['$set'] = set;

        if (Object.keys(unset).length) update['$unset'] = unset;

        const updated = Object.keys(update).length
            ? await this.webhooks.updateById(id, update)
            : await this.getById(id, actor);

        if (!updated) throw ApiError.notFound('WEBHOOK_NOT_FOUND');

        return updated;
    }

    async rotateSecret(id: string, actor: AuthUser): Promise<WebhookEntity & { secret: string }> {
        await this.getById(id, actor);
        const secret = WebhooksService.newSecret();
        const updated = await this.webhooks.updateById(id, { $set: { secret } });

        if (!updated) throw ApiError.notFound('WEBHOOK_NOT_FOUND');

        return { ...updated, secret };
    }

    async delete(id: string, actor: AuthUser): Promise<void> {
        await this.getById(id, actor);
        await this.webhooks.deleteById(id);
    }

    async test(id: string, actor: AuthUser): Promise<{ event_id: string; queued: true }> {
        const webhook = await this.getById(id, actor);
        const eventId = await this.outbox.enqueue(
            'webhook.test',
            { webhook_id: webhook._id.toHexString(), requested_by: actor.id },
            { organizationId: webhook.organization_id, onlyWebhookId: webhook._id },
        );
        this.outbox.poke();

        return { event_id: eventId, queued: true };
    }

    listEvents(query: ListOutboxQuery, actor: AuthUser): Promise<PaginatedResult<OutboxEventEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'status', 'type'],
            defaultSort: 'created_at',
        });
        const filter: FilterQuery<OutboxEvent> = this.scope(query.organization_id, actor);

        if (query.type) filter['type'] = query.type;

        if (query.status) filter['status'] = query.status;

        return this.events.list(filter, pagination);
    }

    async replayEvent(id: string, actor: AuthUser): Promise<OutboxEventEntity> {
        const event = await this.events.findOne({ id });

        if (!event || !this.ownsEvent(event, actor)) throw ApiError.notFound('NOT_FOUND');

        if (event.status !== 'failed') throw ApiError.conflict('CONFLICT');

        const deliveries = event.deliveries.map((delivery) =>
            delivery.status === 'delivered' ? delivery : { ...delivery, status: 'pending' as const },
        );
        await this.events.finish(event._id, {
            status: 'pending',
            attempts: 0,
            next_attempt_at: new Date(),
            deliveries,
        });
        this.outbox.poke();
        const replayed = await this.events.findOne({ id });

        if (!replayed) throw ApiError.notFound('NOT_FOUND');

        return replayed;
    }

    private scope<T>(organizationId: string | undefined, actor: AuthUser): FilterQuery<T> {
        if (actor.role === ROLES.SUPER_ADMIN) {
            return organizationId ? { organization_id: new Types.ObjectId(organizationId) } : {};
        }

        if (organizationId) {
            if (!actor.organization_ids.includes(organizationId)) throw ApiError.forbidden('FORBIDDEN');

            return { organization_id: new Types.ObjectId(organizationId) };
        }

        return { organization_id: { $in: actor.organization_ids.map((id) => new Types.ObjectId(id)) } };
    }

    private owns(webhook: WebhookEntity, actor: AuthUser): boolean {
        if (actor.role === ROLES.SUPER_ADMIN) return true;

        return (
            webhook.organization_id !== null &&
            actor.organization_ids.includes(webhook.organization_id.toHexString())
        );
    }

    private ownsEvent(event: OutboxEventEntity, actor: AuthUser): boolean {
        if (actor.role === ROLES.SUPER_ADMIN) return true;

        return (
            event.organization_id !== null &&
            actor.organization_ids.includes(event.organization_id.toHexString())
        );
    }

    private assertUrl(url: string): void {
        const problem = this.delivery.urlProblem(url);

        if (problem) throw ApiError.badRequest('VALIDATION_ERROR', [{ path: 'url', message: problem }]);
    }

    private static newSecret(): string {
        return `whsec_${randomBytes(32).toString('base64url')}`;
    }
}

export type { Webhook };
