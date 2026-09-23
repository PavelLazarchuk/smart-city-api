import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsModule } from '../bookings/bookings.module';
import { ServicesMasker } from '../services/services.masker';
import { SlotsModule } from '../slots/slots.module';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';
import { Organization, OrganizationSchema } from './schemas/organization.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Organization.name, schema: OrganizationSchema }]),
        BookingsModule,
        SlotsModule,
    ],
    providers: [OrganizationsRepository, OrganizationsService, ServicesMasker],
    exports: [OrganizationsService],
})
export class OrganizationsModule {}
