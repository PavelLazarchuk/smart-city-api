import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsModule } from '../bookings/bookings.module';
import { ServicesMasker } from '../services/services.masker';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';
import { Organization, OrganizationSchema } from './schemas/organization.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Organization.name, schema: OrganizationSchema }]),
        BookingsModule,
    ],
    providers: [OrganizationsRepository, OrganizationsService, ServicesMasker],
    exports: [OrganizationsService],
})
export class OrganizationsModule {}
