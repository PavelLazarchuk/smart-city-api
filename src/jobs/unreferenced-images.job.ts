import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';

import { AppConfig } from '../common/config/app-config';
import { texts } from '../common/i18n/messages';
import { MailService } from '../integrations/mail/mail.service';
import { ImagesRepository } from '../modules/images/images.repository';
import { NewsService } from '../modules/news/news.service';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { ServicesService } from '../modules/services/services.service';
import { JobRunner } from './job-runner';
import { buildReportWorkbook, REPORT_CONTENT_TYPE } from './report.workbook';

export const UNREFERENCED_IMAGES_JOB = 'unreferenced_images';

export interface UnreferencedImageRow {
    organization: string;
    src: string;
    size: number;
    uploaded: string;
}

/**
 * "Used" is only as complete as {@link referencedUrls}, so a forgotten field would call a live image unused
 * — hence a mailed report, never a delete.
 */
@Injectable()
export class UnreferencedImagesJob {
    constructor(
        private readonly images: ImagesRepository,
        private readonly organizations: OrganizationsService,
        private readonly news: NewsService,
        private readonly services: ServicesService,
        private readonly mail: MailService,
        private readonly config: AppConfig,
        private readonly runner: JobRunner,
    ) {}

    run(): Promise<unknown> {
        return this.runner.run(UNREFERENCED_IMAGES_JOB, () => this.execute());
    }

    async execute(): Promise<{ rows: number; bytes: number; recipients: number }> {
        const rows = await this.collect();
        const bytes = rows.reduce((total, row) => total + row.size, 0);
        const recipients = this.config.jobs.reportRecipients;

        if (rows.length === 0 || recipients.length === 0) return { rows: rows.length, bytes, recipients: 0 };

        const workbook = await buildReportWorkbook<UnreferencedImageRow>(
            texts.report.unreferencedImages.sheetName,
            [
                {
                    header: texts.report.unreferencedImages.columns.organization,
                    key: 'organization',
                    width: 40,
                },
                { header: texts.report.unreferencedImages.columns.src, key: 'src', width: 70 },
                { header: texts.report.unreferencedImages.columns.size, key: 'size', width: 16 },
                { header: texts.report.unreferencedImages.columns.uploaded, key: 'uploaded', width: 22 },
            ],
            rows,
        );
        await this.mail.send({
            to: recipients,
            subject: texts.mail.unreferencedImagesSubject,
            text: texts.mail.unreferencedImagesBody(rows.length, bytes),
            attachments: [
                {
                    filename: texts.mail.unreferencedImagesFileName,
                    content: workbook,
                    content_type: REPORT_CONTENT_TYPE,
                },
            ],
        });

        return { rows: rows.length, bytes, recipients: recipients.length };
    }

    async collect(): Promise<UnreferencedImageRow[]> {
        const [referenced, labels] = await Promise.all([this.referencedUrls(), this.organizations.labels()]);
        const rows: UnreferencedImageRow[] = [];

        for await (const image of this.images.iterateAll()) {
            if (referenced.has(image.src)) continue;

            rows.push({
                organization: this.labelFor(labels, image.organization_id),
                src: image.src,
                size: image.size,
                uploaded: image.created_at.toISOString(),
            });
        }

        return rows;
    }

    /** Every place an image URL can be stored. Add to this list, never quietly around it. */
    private async referencedUrls(): Promise<Set<string>> {
        const sources = await Promise.all([
            this.organizations.imageReferences(),
            this.news.imageReferences(),
            this.services.imageReferences(),
        ]);
        const referenced = new Set<string>();

        for (const source of sources) {
            for (const url of source) {
                if (url) referenced.add(url);
            }
        }

        return referenced;
    }

    private labelFor(labels: Map<string, string>, organizationId: Types.ObjectId): string {
        return (
            labels.get(organizationId.toHexString()) ?? texts.report.unreferencedImages.unknownOrganization
        );
    }
}
