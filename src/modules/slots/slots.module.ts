import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Slot, SlotSchema } from './schemas/slot.schema';
import { SlotsRepository } from './slots.repository';

@Module({
    imports: [MongooseModule.forFeature([{ name: Slot.name, schema: SlotSchema }])],
    providers: [SlotsRepository],
    exports: [SlotsRepository],
})
export class SlotsModule {}
