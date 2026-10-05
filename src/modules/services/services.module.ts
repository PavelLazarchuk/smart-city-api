import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsDataModule } from '../bookings/bookings-data.module';
import { CategoriesModule } from '../categories/categories.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SlotsModule } from '../slots/slots.module';
import { ServiceRevision, ServiceRevisionSchema } from './schemas/service-revision.schema';
import { Service, ServiceSchema } from './schemas/service.schema';
import { ServiceRevisionsRepository } from './service-revisions.repository';
import { ServicesMasker } from './services.masker';
import { ServicesRepository } from './services.repository';
import { ServicesService } from './services.service';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Service.name, schema: ServiceSchema },
            { name: ServiceRevision.name, schema: ServiceRevisionSchema },
        ]),
        BookingsDataModule,
        SlotsModule,
        OrganizationsModule,
        CategoriesModule,
    ],
    providers: [ServicesRepository, ServiceRevisionsRepository, ServicesMasker, ServicesService],
    exports: [ServicesService, ServicesMasker],
})
export class ServicesModule {}
