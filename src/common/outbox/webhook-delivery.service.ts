import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import { AppConfig } from '../config/app-config';
import { isPrivateHost, webhookUrlProblem } from './webhook-url';
import { type OutboxEventEntity } from './outbox.repository';
import { type WebhookWithSecret } from './webhooks.repository';

export interface WebhookBody {
    id: string;
    type: string;
    created_at: string;
    organization_id: string | null;
    data: Record<string, unknown>;
}

@Injectable()
export class WebhookDeliveryService {
    constructor(private readonly config: AppConfig) {}

    body(event: OutboxEventEntity): WebhookBody {
        return {
            id: event.id,
            type: event.type,
            created_at: event.created_at.toISOString(),
            organization_id: event.organization_id ? event.organization_id.toHexString() : null,
            data: event.payload,
        };
    }

    sign(secret: string, timestamp: string, body: string): string {
        return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    }

    urlProblem(url: string): string | null {
        return webhookUrlProblem(url, {
            allowPrivateHosts: this.config.outbox.allowPrivateHosts,
            requireHttps: this.config.isProduction && !this.config.outbox.allowPrivateHosts,
        });
    }

    async deliver(webhook: WebhookWithSecret, event: OutboxEventEntity): Promise<void> {
        const problem = this.urlProblem(webhook.url);

        if (problem) throw new Error(`webhook url refused: ${problem}`);

        await this.assertResolvesPublicly(webhook.url);
        const body = JSON.stringify(this.body(event));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const response = await fetch(webhook.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'user-agent': 'smart-city-api-webhooks/1',
                'x-webhook-id': event.id,
                'x-webhook-event': event.type,
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': this.sign(webhook.secret, timestamp, body),
            },
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(this.config.outbox.webhookTimeoutMs),
        });
        await response.body?.cancel();

        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    }

    private async assertResolvesPublicly(raw: string): Promise<void> {
        if (this.config.outbox.allowPrivateHosts) return;

        const { hostname } = new URL(raw);

        if (isPrivateHost(hostname)) throw new Error('webhook url refused: private address');

        const addresses = await lookup(hostname, { all: true }).catch(() => []);

        for (const { address } of addresses) {
            if (isPrivateHost(address)) throw new Error('webhook url refused: resolves to a private address');
        }
    }
}
