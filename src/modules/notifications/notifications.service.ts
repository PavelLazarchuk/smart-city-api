import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type FilterQuery, Types } from 'mongoose';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { NOTIFICATIONS } from '../../common/config/constants';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ORGANIZATION_ROLES } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { PaginationService } from '../../common/pagination/pagination.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type ListNotificationsQuery,
    type NotificationResource,
    type NotificationScope,
    type ReadAllInput,
    type ReadAllResult,
    type UnreadCount,
    type UnreadCountQuery,
} from './dto/notification.schemas';
import { type NotificationEntity, NotificationsRepository } from './notifications.repository';
import { type Notification } from './schemas/notification.schema';

export interface NotificationOwners {
    user: Types.ObjectId | null;
    organizations: Types.ObjectId[];
}

interface Visible {
    filter: FilterQuery<Notification>;
    owners: NotificationOwners;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
    constructor(
        private readonly notifications: NotificationsRepository,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly cascade: CascadeRegistry,
    ) {}

    onModuleInit(): void {
        this.cascade.register('user', 'notifications.delete', async (userId, ctx) => {
            await this.notifications.deleteByUser(userId, ctx.session);
            await this.notifications.deleteBySubject(userId, ctx.session);
        });
        this.cascade.register('organization', 'notifications.delete', async (organizationId, ctx) => {
            await this.notifications.deleteByOrganization(organizationId, ctx.session);
        });
    }

    async unreadCount(actor: AuthUser, query: UnreadCountQuery): Promise<UnreadCount> {
        const visible = this.visible(actor, query);

        if (!visible) return query.by_organization ? { unread: 0, by_organization: [] } : { unread: 0 };

        const filter = { ...visible.filter, status: 'unread' };

        if (!query.by_organization) return { unread: await this.notifications.count(filter) };

        const byOrganization = await this.notifications.countByOrganization(filter);

        return {
            unread: byOrganization.reduce((sum, row) => sum + row.unread, 0),
            by_organization: byOrganization,
        };
    }

    async list(
        actor: AuthUser,
        query: ListNotificationsQuery,
    ): Promise<PaginatedResult<NotificationResource>> {
        const { page, limit, skip } = this.pagination.resolve(query, {
            sortable: ['created_at'],
            defaultSort: 'created_at',
        });
        const visible = this.visible(actor, query);

        if (!visible) return { items: [], total: 0, page, limit, meta_extra: { unread: 0 } };

        const unread = { ...visible.filter, status: 'unread' };
        const read = { ...visible.filter, status: 'read' };
        const status = query.status ?? 'all';
        const [unreadTotal, readTotal] = await Promise.all([
            this.notifications.count(unread),
            status === 'unread' ? Promise.resolve(0) : this.notifications.count(read),
        ]);
        let rows: NotificationEntity[];
        let total: number;

        if (status === 'unread') {
            rows = await this.notifications.page(unread, skip, limit);
            total = unreadTotal;
        } else if (status === 'read') {
            rows = await this.notifications.page(read, skip, limit);
            total = readTotal;
        } else {
            const head = skip < unreadTotal ? await this.notifications.page(unread, skip, limit) : [];
            const tail = await this.notifications.page(
                read,
                Math.max(0, skip - unreadTotal),
                limit - head.length,
            );
            rows = [...head, ...tail];
            total = unreadTotal + readTotal;
        }

        return {
            items: await this.resources(rows),
            total,
            page,
            limit,
            meta_extra: { unread: unreadTotal },
        };
    }

    async markRead(actor: AuthUser, id: string): Promise<void> {
        const visible = this.visible(actor, {});
        const row = visible ? await this.notifications.findOne({ ...visible.filter, id }) : null;

        if (!row) throw ApiError.notFound('NOTIFICATION_NOT_FOUND');

        if (row.status === 'read') return;

        await this.notifications.markRead({ _id: row._id }, new Date());
        await this.trimRead(
            row.audience === 'client'
                ? { user: row.user_id, organizations: [] }
                : { user: null, organizations: [row.organization_id] },
        );
    }

    async markAllRead(actor: AuthUser, input: ReadAllInput): Promise<ReadAllResult> {
        const visible = this.visible(actor, input);

        if (!visible) return { updated: 0 };

        const filter: FilterQuery<Notification> = input.before
            ? { ...visible.filter, created_at: { $lte: new Date(input.before) } }
            : visible.filter;
        const updated = await this.notifications.markRead(filter, new Date());

        if (updated > 0) await this.trimRead(visible.owners);

        return { updated };
    }

    trimUnread(owners: NotificationOwners): Promise<void> {
        return this.trim(owners, 'unread', NOTIFICATIONS.maxUnread);
    }

    private trimRead(owners: NotificationOwners): Promise<void> {
        return this.trim(owners, 'read', NOTIFICATIONS.keepRead);
    }

    private async trim(owners: NotificationOwners, status: 'read' | 'unread', keep: number): Promise<void> {
        if (owners.user) await this.notifications.trim({ user_id: owners.user }, status, keep);

        for (const organizationId of owners.organizations)
            await this.notifications.trim(
                { organization_id: organizationId, audience: 'staff' },
                status,
                keep,
            );
    }

    private visible(actor: AuthUser, scope: NotificationScope): Visible | null {
        const me = new Types.ObjectId(actor.id);
        const staffOf = ORGANIZATION_ROLES.includes(actor.role)
            ? actor.organization_ids.filter((id) => !scope.organization_id || id === scope.organization_id)
            : [];
        const organizations = scope.audience === 'client' ? [] : staffOf.map((id) => new Types.ObjectId(id));
        const user = scope.audience === 'staff' ? null : me;
        const branches: FilterQuery<Notification>[] = [];

        if (user)
            branches.push({
                user_id: user,
                ...(scope.organization_id
                    ? { organization_id: new Types.ObjectId(scope.organization_id) }
                    : {}),
            });

        if (organizations.length > 0)
            branches.push({
                organization_id: { $in: organizations },
                audience: 'staff',
                subject_user_id: { $ne: me },
            });

        if (branches.length === 0) return null;

        return {
            filter: branches.length === 1 ? branches[0]! : { $or: branches },
            owners: { user, organizations },
        };
    }

    private async resources(rows: NotificationEntity[]): Promise<NotificationResource[]> {
        const organizations = await this.organizations.findManyByIds(
            rows.map((row) => row.organization_id.toHexString()),
        );
        const labels = new Map(organizations.map((item) => [item._id.toHexString(), item.main_label]));

        return rows.map((row) => {
            const organizationId = row.organization_id.toHexString();

            return {
                id: row.id,
                type: row.type,
                audience: row.audience,
                status: row.status,
                title: row.title,
                body: row.body,
                organization: {
                    id: organizationId,
                    label: labels.get(organizationId) ?? row.organization_label,
                },
                data: row.data ?? {},
                created_at: row.created_at.toISOString(),
                read_at: row.read_at ? row.read_at.toISOString() : null,
            };
        });
    }
}
