import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type ClientSession, Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../config/app-config';
import { MetricsService } from '../metrics/metrics.service';
import { type OutboxEventEntity, OutboxRepository } from './outbox.repository';
import { type OutboxEvent, type OutboxDelivery, type OutboxEventType } from './schemas/outbox-event.schema';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhooksRepository } from './webhooks.repository';

export type OutboxHandler = (event: OutboxEventEntity) => Promise<void>;

export interface EnqueueOptions {
    organizationId?: Types.ObjectId | string | null;
    internal?: Record<string, unknown>;
    onlyWebhookId?: Types.ObjectId;
    session?: ClientSession;
}

export interface EnqueueRequest extends EnqueueOptions {
    type: OutboxEventType;
    payload: Record<string, unknown>;
}

export interface DispatchSummary {
    processed: number;
    delivered: number;
    retried: number;
    failed: number;
}

const CLAIM_LEASE_MS = 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;

@Injectable()
export class OutboxService {
    private readonly handlers = new Map<OutboxEventType, { name: string; handler: OutboxHandler }[]>();
    private draining: Promise<DispatchSummary> | null = null;
    private rerun = false;

    constructor(
        private readonly events: OutboxRepository,
        private readonly webhooks: WebhooksRepository,
        private readonly delivery: WebhookDeliveryService,
        private readonly config: AppConfig,
        private readonly metrics: MetricsService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(OutboxService.name);
    }

    registerHandler(type: OutboxEventType, name: string, handler: OutboxHandler): void {
        const list = this.handlers.get(type) ?? [];
        list.push({ name, handler });
        this.handlers.set(type, list);
    }

    async enqueue(
        type: OutboxEventType,
        payload: Record<string, unknown>,
        options: EnqueueOptions = {},
    ): Promise<string> {
        const row = this.row(type, payload, options);
        await this.events.create(row, options.session);

        return row.id;
    }

    async enqueueMany(events: EnqueueRequest[], session?: ClientSession): Promise<string[]> {
        const rows = events.map((event) => this.row(event.type, event.payload, event));
        await this.events.createMany(rows, session);

        return rows.map((row) => row.id);
    }

    private row(
        type: OutboxEventType,
        payload: Record<string, unknown>,
        options: EnqueueOptions,
    ): Partial<OutboxEvent> & { id: string } {
        const organizationId =
            options.organizationId === undefined || options.organizationId === null
                ? null
                : typeof options.organizationId === 'string'
                  ? new Types.ObjectId(options.organizationId)
                  : options.organizationId;

        return {
            id: randomUUID(),
            type,
            organization_id: organizationId,
            payload,
            internal: options.internal ?? null,
            only_webhook_id: options.onlyWebhookId ?? null,
            status: 'pending',
            attempts: 0,
            next_attempt_at: new Date(),
            claimed_until: null,
            deliveries: [],
        };
    }

    poke(): void {
        void this.dispatch().catch((error: unknown) => {
            this.logger.error({ err: error }, 'outbox dispatch failed');
        });
    }

    dispatch(now = new Date()): Promise<DispatchSummary> {
        if (this.draining) {
            // An event committed while a pass is finishing must not wait for the next cron tick.
            this.rerun = true;

            return this.draining;
        }

        this.draining = this.drainUntilQuiet(now).finally(() => {
            this.draining = null;
        });

        return this.draining;
    }

    private async drainUntilQuiet(now: Date): Promise<DispatchSummary> {
        const summary = await this.drain(now);

        while (this.rerun) {
            this.rerun = false;
            const more = await this.drain(new Date());
            summary.processed += more.processed;
            summary.delivered += more.delivered;
            summary.retried += more.retried;
            summary.failed += more.failed;
        }

        return summary;
    }

    private async drain(now: Date): Promise<DispatchSummary> {
        const summary: DispatchSummary = { processed: 0, delivered: 0, retried: 0, failed: 0 };

        for (let i = 0; i < this.config.outbox.batchSize; i += 1) {
            const event = await this.events.claimNext(now, CLAIM_LEASE_MS);

            if (!event) break;

            summary.processed += 1;
            const outcome = await this.process(event);
            summary[outcome] += 1;
        }

        return summary;
    }

    private async process(event: OutboxEventEntity): Promise<'delivered' | 'retried' | 'failed'> {
        const deliveries = await this.targetsOf(event);
        const now = new Date();

        for (const delivery of deliveries) {
            if (delivery.status === 'delivered') continue;

            try {
                await this.attempt(event, delivery.target);
                delivery.status = 'delivered';
                delivery.delivered_at = now;
                delete delivery.last_error;
            } catch (error) {
                delivery.attempts += 1;
                delivery.last_error = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    { event: event.id, type: event.type, target: delivery.target, err: error },
                    'outbox delivery attempt failed',
                );
            }

            this.metrics.countOutboxDelivery(
                event.type,
                delivery.target.split(':')[0] ?? 'unknown',
                delivery.status === 'delivered' ? 'ok' : 'failed',
            );
        }

        const pending = deliveries.filter((delivery) => delivery.status !== 'delivered');
        const attempts = event.attempts + 1;

        if (pending.length === 0) {
            await this.events.finish(event._id, {
                status: 'delivered',
                attempts,
                next_attempt_at: event.next_attempt_at,
                deliveries,
                delivered_at: now,
            });

            return 'delivered';
        }

        const lastError = pending.map((delivery) => `${delivery.target}: ${delivery.last_error}`).join('; ');

        if (attempts >= this.config.outbox.maxAttempts) {
            for (const delivery of pending) delivery.status = 'failed';

            await this.events.finish(event._id, {
                status: 'failed',
                attempts,
                next_attempt_at: event.next_attempt_at,
                deliveries,
                last_error: lastError,
            });
            this.logger.error(
                { event: event.id, type: event.type, lastError },
                'outbox event failed for good',
            );

            return 'failed';
        }

        const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));
        await this.events.finish(event._id, {
            status: 'pending',
            attempts,
            next_attempt_at: new Date(now.getTime() + backoff),
            deliveries,
            last_error: lastError,
        });

        return 'retried';
    }

    private async targetsOf(event: OutboxEventEntity): Promise<OutboxDelivery[]> {
        if (event.deliveries.length > 0) return event.deliveries.map((delivery) => ({ ...delivery }));

        const targets: OutboxDelivery[] = [];

        if (!event.only_webhook_id) {
            for (const { name } of this.handlers.get(event.type) ?? []) {
                targets.push({ target: `handler:${name}`, status: 'pending', attempts: 0 });
            }
        }

        const webhooks = event.only_webhook_id
            ? [await this.webhooks.findWithSecret(event.only_webhook_id.toHexString())].filter(
                  (webhook) => webhook !== null,
              )
            : await this.webhooks.subscribers(event.type, event.organization_id);

        for (const webhook of webhooks) {
            targets.push({ target: `webhook:${webhook._id.toHexString()}`, status: 'pending', attempts: 0 });
        }

        return targets;
    }

    private async attempt(event: OutboxEventEntity, target: string): Promise<void> {
        const [kind, name] = target.split(':', 2);

        if (kind === 'handler') {
            const entry = (this.handlers.get(event.type) ?? []).find((item) => item.name === name);

            if (!entry) throw new Error(`no handler "${name}" registered for ${event.type}`);

            await entry.handler(event);

            return;
        }

        if (kind === 'webhook' && name) {
            const webhook = await this.webhooks.findWithSecret(name);

            if (!webhook) throw new Error('webhook no longer exists');

            if (!webhook.enabled) throw new Error('webhook disabled');

            try {
                await this.delivery.deliver(webhook, event);
                await this.webhooks.recordOutcome(webhook._id, true);
            } catch (error) {
                await this.webhooks.recordOutcome(
                    webhook._id,
                    false,
                    error instanceof Error ? error.message : String(error),
                );
                throw error;
            }

            return;
        }

        throw new Error(`unknown delivery target "${target}"`);
    }
}
