import {
    type CallHandler,
    type ExecutionContext,
    HttpStatus,
    Injectable,
    type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Response } from 'express';
import { type Observable, tap } from 'rxjs';

import { type RequestWithUser } from '../../common/decorators/current-user.decorator';
import { TRACK_EVENT_KEY, type TrackEventOptions } from '../../common/decorators/track-event.decorator';
import { AnalyticsService, type EventFields } from './analytics.service';

@Injectable()
export class TrackEventInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly analytics: AnalyticsService,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const options = this.reflector.get<TrackEventOptions | undefined>(
            TRACK_EVENT_KEY,
            context.getHandler(),
        );

        if (!options) return next.handle();

        const request = context.switchToHttp().getRequest<RequestWithUser & { body?: unknown }>();
        const response = context.switchToHttp().getResponse<Response>();

        return next.handle().pipe(
            tap((result) => {
                if (response.statusCode === Number(HttpStatus.NOT_MODIFIED)) return;

                const fields = (options.extract ? options.extract(result, request.body) : {}) as EventFields;
                this.analytics.record(options.type, fields, request.user);
            }),
        );
    }
}
