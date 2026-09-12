import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MailModule } from '../../integrations/mail/mail.module';
import { BookingsModule } from '../bookings/bookings.module';
import { CategoriesModule } from '../categories/categories.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BookingsService } from './bookings.service';
import { Service, ServiceSchema } from './schemas/service.schema';
import { ServicesController } from './services.controller';
import { ServicesMasker } from './services.masker';
import { ServicesRepository } from './services.repository';
import { ServicesService } from './services.service';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Service.name, schema: ServiceSchema }]),
        BookingsModule,
        OrganizationsModule,
        CategoriesModule,
        MailModule,
    ],
    controllers: [ServicesController],
    providers: [ServicesRepository, ServicesMasker, ServicesService, BookingsService],
    exports: [ServicesService, BookingsService],
})
export class ServicesModule {}
