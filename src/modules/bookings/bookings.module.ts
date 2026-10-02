import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsRepository } from './bookings.repository';
import { Booking, BookingSchema } from './schemas/booking.schema';
import { BookingSuspension, BookingSuspensionSchema } from './schemas/suspension.schema';
import { WaitlistEntry, WaitlistEntrySchema } from './schemas/waitlist.schema';
import { SuspensionsRepository } from './suspensions.repository';
import { WaitlistRepository } from './waitlist.repository';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Booking.name, schema: BookingSchema },
            { name: WaitlistEntry.name, schema: WaitlistEntrySchema },
            { name: BookingSuspension.name, schema: BookingSuspensionSchema },
        ]),
    ],
    providers: [BookingsRepository, WaitlistRepository, SuspensionsRepository],
    exports: [BookingsRepository, WaitlistRepository, SuspensionsRepository],
})
export class BookingsModule {}
