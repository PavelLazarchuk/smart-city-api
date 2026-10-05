import { Module } from '@nestjs/common';

import { BookingsModule } from '../bookings/bookings.module';
import { ServicesController } from './services.controller';
import { ServicesModule } from './services.module';

@Module({
    imports: [ServicesModule, BookingsModule],
    controllers: [ServicesController],
})
export class ServicesHttpModule {}
