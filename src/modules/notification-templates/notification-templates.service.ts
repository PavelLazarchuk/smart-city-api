import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { NOTIFICATION_TEMPLATE_LIMITS } from '../../common/config/constants';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ApiError, type ApiErrorDetail } from '../../common/http/api-error';
import { texts } from '../../common/i18n/messages';
import {
    compileTemplate,
    renderTemplate,
    type TemplateData,
    TemplateError,
} from '../../common/i18n/template';
import { OrganizationsService } from '../organizations/organizations.service';
import {
    type NotificationTemplateResource,
    type PreviewNotificationTemplateInput,
    type RenderedNotification,
    type SaveNotificationTemplateInput,
} from './dto/notification-template.schemas';
import {
    defaultTemplate,
    NOTIFICATION_KEYS,
    type NotificationKey,
    NOTIFICATIONS,
} from './notification-catalogue';
import {
    type NotificationTemplateEntity,
    NotificationTemplatesRepository,
} from './notification-templates.repository';

interface Template {
    subject: string | null;
    body: string;
}

function isKey(value: string): value is NotificationKey {
    return (NOTIFICATION_KEYS as readonly string[]).includes(value);
}

function singleLine(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

@Injectable()
export class NotificationTemplatesService implements OnModuleInit {
    constructor(
        private readonly templates: NotificationTemplatesRepository,
        private readonly organizations: OrganizationsService,
        private readonly cascade: CascadeRegistry,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(NotificationTemplatesService.name);
    }

    onModuleInit(): void {
        this.cascade.register(
            'organization',
            'notification_templates.delete',
            async (organizationId, ctx) => {
                await this.templates.deleteByOrganization(organizationId, ctx.session);
            },
        );
    }

    async list(organizationId: string): Promise<NotificationTemplateResource[]> {
        await this.organizations.assertExists(organizationId);
        const rows = new Map(
            (await this.templates.listByOrganization(organizationId)).map((row) => [row.key, row]),
        );

        return NOTIFICATION_KEYS.map((key) => this.resource(key, rows.get(key) ?? null));
    }

    async get(organizationId: string, rawKey: string): Promise<NotificationTemplateResource> {
        const key = this.key(rawKey);
        await this.organizations.assertExists(organizationId);

        return this.resource(key, await this.templates.find(organizationId, key));
    }

    async save(
        organizationId: string,
        rawKey: string,
        input: SaveNotificationTemplateInput,
        actor: AuthUser,
    ): Promise<NotificationTemplateResource> {
        const key = this.key(rawKey);
        await this.organizations.assertExists(organizationId);
        const template = this.validate(key, { subject: input.subject ?? null, body: input.body });
        const row = await this.templates.save(organizationId, key, {
            ...template,
            updated_by: new Types.ObjectId(actor.id),
        });

        return this.resource(key, row);
    }

    async reset(organizationId: string, rawKey: string): Promise<void> {
        const key = this.key(rawKey);
        await this.organizations.assertExists(organizationId);
        await this.templates.remove(organizationId, key);
    }

    async preview(
        organizationId: string,
        rawKey: string,
        input: PreviewNotificationTemplateInput,
    ): Promise<RenderedNotification> {
        const key = this.key(rawKey);
        await this.organizations.assertExists(organizationId);
        const current = await this.effective(organizationId, key);
        const template = this.validate(key, {
            subject: input.subject === undefined ? current.subject : input.subject,
            body: input.body ?? current.body,
        });

        return this.render(key, template, texts.notificationSample);
    }

    async mail(
        organizationId: string | null,
        key: NotificationKey,
        data: TemplateData,
    ): Promise<{ subject: string; text: string }> {
        const rendered = await this.compose(organizationId, key, data);

        return { subject: rendered.subject ?? '', text: rendered.body };
    }

    async sms(organizationId: string | null, key: NotificationKey, data: TemplateData): Promise<string> {
        return (await this.compose(organizationId, key, data)).body;
    }

    private async compose(
        organizationId: string | null,
        key: NotificationKey,
        data: TemplateData,
    ): Promise<RenderedNotification> {
        const custom =
            organizationId && Types.ObjectId.isValid(organizationId)
                ? await this.templates.find(organizationId, key)
                : null;

        if (custom) {
            try {
                const rendered = this.render(key, custom, data);

                if (rendered.body && rendered.subject !== '') return rendered;

                this.logger.warn(
                    { organization_id: organizationId, key },
                    'notification template rendered empty, falling back to the default',
                );
            } catch (error) {
                this.logger.warn(
                    { err: error, organization_id: organizationId, key },
                    'notification template no longer renders, falling back to the default',
                );
            }
        }

        return this.render(key, defaultTemplate(key), data);
    }

    private async effective(organizationId: string, key: NotificationKey): Promise<Template> {
        return (await this.templates.find(organizationId, key)) ?? defaultTemplate(key);
    }

    private render(key: NotificationKey, template: Template, data: TemplateData): RenderedNotification {
        const { variables } = NOTIFICATIONS[key];

        return {
            subject:
                template.subject === null
                    ? null
                    : singleLine(renderTemplate(template.subject, variables, data)),
            body: renderTemplate(template.body, variables, data),
        };
    }

    private validate(key: NotificationKey, template: Template): Template {
        const { channel, variables } = NOTIFICATIONS[key];
        const details: ApiErrorDetail[] = [];

        if (channel === 'mail' && template.subject === null)
            details.push({ path: 'subject', message: 'An e-mail template needs a subject' });

        if (channel === 'sms' && template.subject !== null)
            details.push({ path: 'subject', message: 'An SMS template has no subject' });

        if (channel === 'sms' && template.body.length > NOTIFICATION_TEMPLATE_LIMITS.smsBody)
            details.push({
                path: 'body',
                message: `An SMS template is limited to ${NOTIFICATION_TEMPLATE_LIMITS.smsBody} characters`,
            });

        for (const field of ['subject', 'body'] as const) {
            const source = template[field];

            if (source === null) continue;

            try {
                compileTemplate(source, variables);
            } catch (error) {
                if (!(error instanceof TemplateError)) throw error;

                details.push({ path: field, message: error.message, variables: [...variables] });
            }
        }

        if (details.length > 0) throw ApiError.badRequest('VALIDATION_ERROR', details);

        return template;
    }

    private key(raw: string): NotificationKey {
        if (!isKey(raw)) throw ApiError.notFound('NOTIFICATION_TEMPLATE_NOT_FOUND');

        return raw;
    }

    private resource(
        key: NotificationKey,
        row: NotificationTemplateEntity | null,
    ): NotificationTemplateResource {
        const { event, channel, variables } = NOTIFICATIONS[key];
        const fallback = defaultTemplate(key);

        return {
            key,
            event,
            channel,
            variables: [...variables],
            custom: row !== null,
            subject: row ? row.subject : fallback.subject,
            body: row ? row.body : fallback.body,
            default_subject: fallback.subject,
            default_body: fallback.body,
            updated_at: row ? row.updated_at.toISOString() : null,
            updated_by: row?.updated_by ? row.updated_by.toHexString() : null,
        };
    }
}
