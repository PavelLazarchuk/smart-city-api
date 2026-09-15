import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OutboxRepository } from './outbox.repository';
import { OutboxService } from './outbox.service';
import { OutboxEvent, OutboxEventSchema } from './schemas/outbox-event.schema';
import { Webhook, WebhookSchema } from './schemas/webhook.schema';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhooksRepository } from './webhooks.repository';

@Global()
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: OutboxEvent.name, schema: OutboxEventSchema },
            { name: Webhook.name, schema: WebhookSchema },
        ]),
    ],
    providers: [OutboxRepository, WebhooksRepository, WebhookDeliveryService, OutboxService],
    exports: [OutboxService, OutboxRepository, WebhooksRepository, WebhookDeliveryService],
})
export class OutboxModule {}
