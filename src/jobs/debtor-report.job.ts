import { Injectable } from '@nestjs/common';

import { AppConfig } from '../common/config/app-config';
import { texts } from '../common/i18n/messages';
import { MailService } from '../integrations/mail/mail.service';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { type ServiceEntity } from '../modules/services/services.repository';
import { ServicesService } from '../modules/services/services.service';
import { type OptionSlotStats, SlotsRepository } from '../modules/slots/slots.repository';
import { dateOnlyIn } from '../common/time/zone';
import { JobRunner } from './job-runner';
import { buildReportWorkbook, REPORT_CONTENT_TYPE } from './report.workbook';

export const DEBTOR_REPORT_JOB = 'debtor_report';

export interface DebtorRow {
    organization: string;
    service: string;
}

/** "Services without upcoming slots" Excel report, e-mailed to the configured recipients. */
@Injectable()
export class DebtorReportJob {
    constructor(
        private readonly organizations: OrganizationsService,
        private readonly services: ServicesService,
        private readonly slots: SlotsRepository,
        private readonly mail: MailService,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
    ) {}

    run(now = new Date()): Promise<unknown> {
        return this.runner.run(DEBTOR_REPORT_JOB, () => this.execute(now));
    }

    async execute(now: Date): Promise<{ rows: number; recipients: number }> {
        const rows = await this.collect(now);
        const recipients = this.config.jobs.reportRecipients;

        if (recipients.length === 0) return { rows: rows.length, recipients: 0 };

        const workbook = await buildReportWorkbook<DebtorRow>(
            texts.report.sheetName,
            [
                { header: texts.report.columns.organization, key: 'organization', width: 60 },
                { header: texts.report.columns.service, key: 'service', width: 60 },
            ],
            rows,
        );
        await this.mail.send({
            to: recipients,
            subject: texts.mail.reportSubject,
            text: texts.mail.reportBody(rows.length),
            attachments: [
                {
                    filename: texts.mail.reportFileName,
                    content: workbook,
                    content_type: REPORT_CONTENT_TYPE,
                },
            ],
        });

        return { rows: rows.length, recipients: recipients.length };
    }

    async collect(now: Date): Promise<DebtorRow[]> {
        const organizations = await this.organizations.findAllForReport();
        const byId = new Map(
            organizations.map((organization) => [organization._id.toHexString(), organization]),
        );
        const [services, stats] = await Promise.all([
            this.services.findAllForDebtorReport(),
            this.slots.optionStats(),
        ]);
        const byOption = new Map(
            stats.map((row) => [`${row.service_id.toHexString()}|${row.option_id}`, row]),
        );
        const rows: DebtorRow[] = [];

        for (const service of services) {
            const organization = byId.get(service.organization_id.toHexString());

            if (!organization || service.deleted_at || service.status === 'archived') continue;

            const today = dateOnlyIn(now, organization.timezone ?? this.config.jobs.timezone);

            const statsOf = (optionId: string): OptionSlotStats | undefined =>
                byOption.get(`${service._id.toHexString()}|${optionId}`);

            if (DebtorReportJob.isDebtor(service, statsOf, today)) {
                rows.push({
                    organization: organization.main_label,
                    service: service.value.heading_value || service.label || texts.report.untitledService,
                });
            }
        }

        return rows;
    }

    static isDebtor(
        service: ServiceEntity,
        statsOf: (optionId: string) => OptionSlotStats | undefined,
        today: string,
    ): boolean {
        for (const option of service.options) {
            if (option.service_type !== 'service_apply' || !option.enabled || option.recurrent_dates?.length)
                continue;

            const stats = statsOf(option.id);

            if (!stats || stats.total === 0) return true;

            if (stats.dated > 0 && (stats.last_date === null || stats.last_date < today)) return true;
        }

        return false;
    }
}
