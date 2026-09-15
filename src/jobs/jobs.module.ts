import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { MailModule } from '../integrations/mail/mail.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { ArchivesModule } from '../modules/archives/archives.module';
import { BookingsModule } from '../modules/bookings/bookings.module';
import { ImagesModule } from '../modules/images/images.module';
import { NewsModule } from '../modules/news/news.module';
import { OrganizationsModule } from '../modules/organizations/organizations.module';
import { ServicesModule } from '../modules/services/services.module';
import { UsersModule } from '../modules/users/users.module';
import { BookingRemindersJob } from './booking-reminders.job';
import { CascadeReconcileJob } from './cascade-reconcile.job';
import { DebtorReportJob } from './debtor-report.job';
import { JobLockService } from './job-lock.service';
import { JobRunner } from './job-runner';
import { JobsScheduler } from './jobs.scheduler';
import { NewsExpiryJob } from './news-expiry.job';
import { OutboxDispatchJob } from './outbox-dispatch.job';
import { RecurrentSlotsJob } from './recurrent-slots.job';
import { JobLock, JobLockSchema } from './schemas/job-lock.schema';
import { SlotExpiryJob } from './slot-expiry.job';
import { StaleBookingsJob } from './stale-bookings.job';
import { StorageGcJob } from './storage-gc.job';
import { TrashPurgeJob } from './trash-purge.job';
import { UnreferencedImagesJob } from './unreferenced-images.job';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        MongooseModule.forFeature([{ name: JobLock.name, schema: JobLockSchema }]),
        ServicesModule,
        BookingsModule,
        NewsModule,
        ArchivesModule,
        ImagesModule,
        UsersModule,
        OrganizationsModule,
        MailModule,
        StorageModule,
    ],
    providers: [
        JobLockService,
        JobRunner,
        RecurrentSlotsJob,
        NewsExpiryJob,
        SlotExpiryJob,
        StaleBookingsJob,
        CascadeReconcileJob,
        StorageGcJob,
        DebtorReportJob,
        UnreferencedImagesJob,
        BookingRemindersJob,
        OutboxDispatchJob,
        TrashPurgeJob,
        JobsScheduler,
    ],
    exports: [
        JobLockService,
        JobRunner,
        RecurrentSlotsJob,
        NewsExpiryJob,
        SlotExpiryJob,
        StaleBookingsJob,
        CascadeReconcileJob,
        StorageGcJob,
        DebtorReportJob,
        UnreferencedImagesJob,
        BookingRemindersJob,
        OutboxDispatchJob,
        TrashPurgeJob,
    ],
})
export class JobsModule {}
