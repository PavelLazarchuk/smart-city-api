import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Settings, SettingsSchema } from './schemas/settings.schema';
import { SettingsController } from './settings.controller';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

@Global()
@Module({
    imports: [MongooseModule.forFeature([{ name: Settings.name, schema: SettingsSchema }])],
    controllers: [SettingsController],
    providers: [SettingsRepository, SettingsService],
    exports: [SettingsService],
})
export class SettingsModule {}
