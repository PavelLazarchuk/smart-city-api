import { HttpStatus } from '@nestjs/common';
import { type Request, type Response } from 'express';

export function notModified(request: Request, response: Response, tag: string | null): boolean {
    if (!tag) return false;

    response.setHeader('ETag', tag);

    if (!request.fresh) return false;

    response.status(HttpStatus.NOT_MODIFIED);

    return true;
}
