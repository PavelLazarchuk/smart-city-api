import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { MailModule } from '../../integrations/mail/mail.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { JobsModule } from '../../jobs/jobs.module';
import { HealthController } from './health.controller';

@Module({
    imports: [TerminusModule.forRoot({ logger: false }), StorageModule, MailModule, JobsModule],
    controllers: [HealthController],
})
export class HealthModule {}
