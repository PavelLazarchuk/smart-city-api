import { Module } from '@nestjs/common';

import { BookingsModule } from './bookings.module';
import { BookingsController } from './bookings.controller';
import { SuspensionsController } from './suspensions.controller';

@Module({
    imports: [BookingsModule],
    controllers: [BookingsController, SuspensionsController],
})
export class BookingsHttpModule {}
