import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';

import { CommonModule } from './common/common.module';
import { AppConfigModule } from './common/config/config.module';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { DatabaseModule } from './common/database/database.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { OrganizationScopeGuard } from './common/guards/organization-scope.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { HttpExceptionFilter } from './common/http/http-exception.filter';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { MetricsMiddleware } from './common/metrics/metrics.middleware';
import { MetricsModule } from './common/metrics/metrics.module';
import { JobsModule } from './jobs/jobs.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ArchivesModule } from './modules/archives/archives.module';
import { AuthModule } from './modules/auth/auth.module';
import { BookingsHttpModule } from './modules/bookings/bookings-http.module';
import { ThrottleModule } from './modules/auth/throttle.module';
import { CategoriesHttpModule } from './modules/categories/categories-http.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { HealthModule } from './modules/health/health.module';
import { ImagesModule } from './modules/images/images.module';
import { InfoSectionsModule } from './modules/infosections/infosections.module';
import { NewsModule } from './modules/news/news.module';
import { OrganizationsHttpModule } from './modules/organizations/organizations-http.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ServicesModule } from './modules/services/services.module';
import { SmsHttpModule } from './modules/sms/sms-http.module';
import { SmsModule } from './modules/sms/sms.module';
import { UsersModule } from './modules/users/users.module';

@Module({
    imports: [
        AppConfigModule,
        LoggingModule,
        MetricsModule,
        DatabaseModule,
        CommonModule,
        IdempotencyModule,
        JwtModule.register({}),
        ThrottleModule,
        AnalyticsModule,
        HealthModule,
        UsersModule,
        AuthModule,
        OrganizationsModule,
        OrganizationsHttpModule,
        CategoriesModule,
        CategoriesHttpModule,
        ServicesModule,
        BookingsHttpModule,
        NewsModule,
        InfoSectionsModule,
        ImagesModule,
        ArchivesModule,
        SmsModule,
        SmsHttpModule,
        JobsModule,
    ],
    providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: OrganizationScopeGuard },
    ],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(MetricsMiddleware, RequestContextMiddleware).forRoutes('{*splat}');
    }
}
