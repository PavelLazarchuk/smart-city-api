import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { AnalyticsEvent, AnalyticsEventSchema } from './schemas/analytics-event.schema';
import { TrackEventInterceptor } from './track-event.interceptor';

@Global()
@Module({
    imports: [MongooseModule.forFeature([{ name: AnalyticsEvent.name, schema: AnalyticsEventSchema }])],
    controllers: [AnalyticsController],
    providers: [
        AnalyticsRepository,
        AnalyticsService,
        { provide: APP_INTERCEPTOR, useClass: TrackEventInterceptor },
    ],
    exports: [AnalyticsService],
})
export class AnalyticsModule {}
