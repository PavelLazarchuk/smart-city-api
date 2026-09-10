import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { MailModule } from '../integrations/mail/mail.module';
import { ArchivesModule } from '../modules/archives/archives.module';
import { NewsModule } from '../modules/news/news.module';
import { OrganizationsModule } from '../modules/organizations/organizations.module';
import { ServicesModule } from '../modules/services/services.module';
import { UsersModule } from '../modules/users/users.module';
import { DebtorReportJob } from './debtor-report.job';
import { JobLockService } from './job-lock.service';
import { JobRunner } from './job-runner';
import { JobsScheduler } from './jobs.scheduler';
import { NewsExpiryJob } from './news-expiry.job';
import { RecurrentSlotsJob } from './recurrent-slots.job';
import { JobLock, JobLockSchema } from './schemas/job-lock.schema';
import { SlotExpiryJob } from './slot-expiry.job';
import { StaleBookingsJob } from './stale-bookings.job';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        MongooseModule.forFeature([{ name: JobLock.name, schema: JobLockSchema }]),
        ServicesModule,
        NewsModule,
        ArchivesModule,
        UsersModule,
        OrganizationsModule,
        MailModule,
    ],
    providers: [
        JobLockService,
        JobRunner,
        RecurrentSlotsJob,
        NewsExpiryJob,
        SlotExpiryJob,
        StaleBookingsJob,
        DebtorReportJob,
        JobsScheduler,
    ],
    exports: [
        JobLockService,
        JobRunner,
        RecurrentSlotsJob,
        NewsExpiryJob,
        SlotExpiryJob,
        StaleBookingsJob,
        DebtorReportJob,
    ],
})
export class JobsModule {}
