import { Module } from '@nestjs/common';

import { ServicesModule } from '../services/services.module';
import { BookingsController } from './bookings.controller';
import { SuspensionsController } from './suspensions.controller';

@Module({
    imports: [ServicesModule],
    controllers: [BookingsController, SuspensionsController],
})
export class BookingsHttpModule {}
