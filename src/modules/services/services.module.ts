import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MailModule } from '../../integrations/mail/mail.module';
import { BookingsModule } from '../bookings/bookings.module';
import { CategoriesModule } from '../categories/categories.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SlotsModule } from '../slots/slots.module';
import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { BookingsService } from './bookings.service';
import { ServiceRevision, ServiceRevisionSchema } from './schemas/service-revision.schema';
import { Service, ServiceSchema } from './schemas/service.schema';
import { ServiceRevisionsRepository } from './service-revisions.repository';
import { ServicesController } from './services.controller';
import { ServicesMasker } from './services.masker';
import { ServicesRepository } from './services.repository';
import { ServicesService } from './services.service';
import { SlotAdminService } from './slot-admin.service';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Service.name, schema: ServiceSchema },
            { name: ServiceRevision.name, schema: ServiceRevisionSchema },
        ]),
        BookingsModule,
        SlotsModule,
        OrganizationsModule,
        CategoriesModule,
        MailModule,
        SmsModule,
        UsersModule,
    ],
    controllers: [ServicesController],
    providers: [
        ServicesRepository,
        ServiceRevisionsRepository,
        ServicesMasker,
        ServicesService,
        BookingsService,
        SlotAdminService,
    ],
    exports: [ServicesService, BookingsService],
})
export class ServicesModule {}
