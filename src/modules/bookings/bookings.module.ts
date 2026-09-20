import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsRepository } from './bookings.repository';
import { Booking, BookingSchema } from './schemas/booking.schema';
import { WaitlistEntry, WaitlistEntrySchema } from './schemas/waitlist.schema';
import { WaitlistRepository } from './waitlist.repository';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Booking.name, schema: BookingSchema },
            { name: WaitlistEntry.name, schema: WaitlistEntrySchema },
        ]),
    ],
    providers: [BookingsRepository, WaitlistRepository],
    exports: [BookingsRepository, WaitlistRepository],
})
export class BookingsModule {}
