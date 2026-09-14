import { Module } from '@nestjs/common';

import { ServicesModule } from '../services/services.module';
import { BookingsController } from './bookings.controller';

@Module({
    imports: [ServicesModule],
    controllers: [BookingsController],
})
export class BookingsHttpModule {}
