import { Module } from '@nestjs/common';

import { MailModule } from '../../integrations/mail/mail.module';
import { ChannelTemplatesModule } from '../channel-templates/channel-templates.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ServicesModule } from '../services/services.module';
import { SlotsModule } from '../slots/slots.module';
import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { BookingCalendarService } from './booking-calendar.service';
import { BookingsDataModule } from './bookings-data.module';
import { BookingsService } from './bookings.service';
import { SlotAdminService } from './slot-admin.service';
import { SuspensionsService } from './suspensions.service';

@Module({
    imports: [
        BookingsDataModule,
        ServicesModule,
        SlotsModule,
        OrganizationsModule,
        UsersModule,
        MailModule,
        SmsModule,
        ChannelTemplatesModule,
    ],
    providers: [BookingsService, BookingCalendarService, SlotAdminService, SuspensionsService],
    exports: [BookingsService, BookingCalendarService, SlotAdminService, SuspensionsService],
})
export class BookingsModule {}
