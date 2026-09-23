import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

import { RequestContext } from './request-context';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

export { REQUEST_ID_HEADER };

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
    use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
        const requestId = resolveRequestId(req);
        res.setHeader(REQUEST_ID_HEADER, requestId);
        RequestContext.run(
            { request_id: requestId, user_agent: req.headers['user-agent']?.slice(0, 256) },
            () => next(),
        );
    }
}
