import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { type OutboxEventEntity } from '../../common/outbox/outbox.repository';
import { OutboxService } from '../../common/outbox/outbox.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { organizationOf, text } from '../bookings/booking-events';
import {
    INBOX_EVENTS,
    notificationData,
    notificationsFor,
    type NotificationRule,
    renderInbox,
    templateData,
} from './notification-rules';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { type Notification } from './schemas/notification.schema';

@Injectable()
export class NotificationDispatcher implements OnModuleInit {
    constructor(
        private readonly outbox: OutboxService,
        private readonly notifications: NotificationsRepository,
        private readonly inbox: NotificationsService,
        private readonly organizations: OrganizationsService,
    ) {}

    onModuleInit(): void {
        for (const type of INBOX_EVENTS)
            this.outbox.registerHandler(type, 'inbox', (event) => this.deliver(event));
    }

    async deliver(event: OutboxEventEntity): Promise<void> {
        const rules = notificationsFor(event);
        const organizationId = organizationOf(event);
        const subject = text(event.payload['user_id']);

        if (rules.length === 0 || !organizationId || !Types.ObjectId.isValid(subject)) return;

        const [organization] = await this.organizations.findManyByIds([organizationId]);

        if (!organization) return;

        const rows = rules.map((rule) =>
            this.row(event, rule, organization._id, organization.main_label, subject),
        );
        await this.notifications.insertNew(rows);
        await this.inbox.trimUnread({
            user: rows.some((row) => row.audience === 'client') ? new Types.ObjectId(subject) : null,
            organizations: rows.some((row) => row.audience === 'staff') ? [organization._id] : [],
        });
    }

    private row(
        event: OutboxEventEntity,
        rule: NotificationRule,
        organizationId: Types.ObjectId,
        organizationLabel: string,
        subject: string,
    ): Partial<Notification> {
        const data = notificationData(event, rule);
        const content = renderInbox(
            rule.type,
            templateData(data, organizationLabel, text(event.payload['until_date']) || undefined),
        );
        const subjectId = new Types.ObjectId(subject);

        return {
            id: randomUUID(),
            audience: rule.audience,
            user_id: rule.audience === 'client' ? subjectId : null,
            organization_id: organizationId,
            organization_label: organizationLabel,
            type: rule.type,
            status: 'unread',
            read_at: null,
            ...content,
            data,
            subject_user_id: rule.audience === 'staff' ? subjectId : null,
            sender_id: null,
            message_id: null,
            source_event_id: event.id,
        };
    }
}
