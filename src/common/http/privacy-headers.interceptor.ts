import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { type Observable } from 'rxjs';

import { type RequestWithUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class PrivacyHeadersInterceptor implements NestInterceptor {
    constructor(private readonly reflector: Reflector) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType() !== 'http') return next.handle();

        const http = context.switchToHttp();
        const request = http.getRequest<Request & RequestWithUser>();
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (!isPublic || request.user) {
            const response = http.getResponse<Response>();
            response.setHeader('Cache-Control', 'private, no-store, max-age=0');
            response.setHeader('Pragma', 'no-cache');
            response.setHeader('X-Robots-Tag', 'noindex, nofollow');
            response.vary('Authorization');
        }

        return next.handle();
    }
}
