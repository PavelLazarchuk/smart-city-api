import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BookingsRepository } from './bookings.repository';
import { Booking, BookingSchema } from './schemas/booking.schema';

/** Storage only: booking rules live with the slots they consume, in `ServicesModule`. */
@Module({
    imports: [MongooseModule.forFeature([{ name: Booking.name, schema: BookingSchema }])],
    providers: [BookingsRepository],
    exports: [BookingsRepository],
})
export class BookingsModule {}
