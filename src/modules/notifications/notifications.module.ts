import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsDataModule } from '../bookings/bookings-data.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { OrganizationMessagesController } from './organization-messages.controller';
import { OrganizationMessagesService } from './organization-messages.service';
import { Notification, NotificationSchema } from './schemas/notification.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }]),
        BookingsDataModule,
        OrganizationsModule,
        UsersModule,
    ],
    controllers: [NotificationsController, OrganizationMessagesController],
    providers: [
        NotificationsRepository,
        NotificationsService,
        NotificationDispatcher,
        OrganizationMessagesService,
    ],
})
export class NotificationsModule {}
