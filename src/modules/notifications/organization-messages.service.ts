import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError } from '../../common/http/api-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { BookingsRepository } from '../bookings/bookings.repository';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import {
    type ListClientsQuery,
    type OrganizationClient,
    type SendMessageInput,
    type SentMessage,
} from './dto/notification.schemas';
import { renderInbox } from './notification-rules';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

@Injectable()
export class OrganizationMessagesService {
    constructor(
        private readonly notifications: NotificationsRepository,
        private readonly inbox: NotificationsService,
        private readonly bookings: BookingsRepository,
        private readonly organizations: OrganizationsService,
        private readonly users: UsersService,
        private readonly pagination: PaginationService,
        private readonly idempotency: IdempotencyService,
    ) {}

    async send(
        organizationId: string,
        input: SendMessageInput,
        actor: AuthUser,
        key?: string,
    ): Promise<{ result: SentMessage; replayed: boolean }> {
        if (!key) return { result: await this.deliver(organizationId, input, actor), replayed: false };

        const outcome = await this.idempotency.run(
            'organizations.messages',
            key,
            actor.id,
            { organization_id: organizationId, ...input },
            async () =>
                (await this.deliver(organizationId, input, actor)) as unknown as Record<string, unknown>,
        );

        return { result: outcome.result as unknown as SentMessage, replayed: outcome.replayed };
    }

    async clients(
        organizationId: string,
        query: ListClientsQuery,
    ): Promise<PaginatedResult<OrganizationClient>> {
        await this.organizations.assertExists(organizationId);
        const { page, limit, skip } = this.pagination.resolve(query, {
            sortable: ['last_booking_at'],
            defaultSort: 'last_booking_at',
        });
        const { items, total } = await this.bookings.clientsOf(organizationId, query.q, skip, limit);

        return {
            items: items.map((row) => ({
                user_id: row.user_id.toHexString(),
                name: row.name,
                phone: row.phone,
                bookings: row.bookings,
                last_booking_at: row.last_booking_at.toISOString(),
            })),
            total,
            page,
            limit,
        };
    }

    private async deliver(
        organizationId: string,
        input: SendMessageInput,
        actor: AuthUser,
    ): Promise<SentMessage> {
        const organization = await this.organizations.getById(organizationId);
        const user = await this.users.findById(input.user_id);

        if (!user || !(await this.bookings.hasClient(organizationId, input.user_id)))
            throw ApiError.notFound('CLIENT_NOT_FOUND');

        const content = renderInbox('organization_message', { organization: organization.main_label });
        const row = await this.notifications.create({
            id: randomUUID(),
            audience: 'client',
            user_id: user._id,
            organization_id: organization._id,
            organization_label: organization.main_label,
            type: 'organization_message',
            status: 'unread',
            read_at: null,
            title: input.title ?? content.title,
            body: input.body,
            data: {},
            subject_user_id: null,
            sender_id: new Types.ObjectId(actor.id),
            message_id: randomUUID(),
            source_event_id: null,
        });
        await this.inbox.trimUnread({ user: user._id, organizations: [] });

        return {
            message_id: row.message_id ?? '',
            user_id: user._id.toHexString(),
            title: row.title,
            body: row.body,
            created_at: row.created_at.toISOString(),
        };
    }
}
