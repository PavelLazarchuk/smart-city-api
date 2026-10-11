import {
    type ArgumentsHost,
    BadRequestException,
    HttpException,
    HttpStatus,
    InternalServerErrorException,
    PayloadTooLargeException,
} from '@nestjs/common';
import { type PinoLogger } from 'nestjs-pino';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';

import { errorMessages } from '../i18n/messages';
import { ApiError } from './api-error';
import { HttpExceptionFilter } from './http-exception.filter';

interface Rendered {
    status: number;
    body: { error: { code: string; message: string; details?: unknown[]; request_id?: string } };
}

function setup(
    request: Record<string, unknown> = { method: 'GET', originalUrl: '/api/things?token=secret' },
) {
    const logger = { setContext: jest.fn(), error: jest.fn(), warn: jest.fn() };
    const filter = new HttpExceptionFilter(logger as unknown as PinoLogger);
    const rendered: Rendered = { status: 0, body: { error: { code: '', message: '' } } };
    const response = {
        status(code: number) {
            rendered.status = code;

            return this;
        },
        json(body: Rendered['body']) {
            rendered.body = body;
        },
    };
    const host = {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost;

    return {
        logger,
        render(exception: unknown): Rendered {
            filter.catch(exception, host);

            return rendered;
        },
    };
}

describe('HttpExceptionFilter', () => {
    it('renders an ApiError with its own code, message and details, and stamps the request id', () => {
        const { render, logger } = setup({ id: 'req-1', method: 'POST', originalUrl: '/api/x' });
        const result = render(
            ApiError.unprocessable('PAGE_OUT_OF_RANGE', [{ path: 'page', message: 'too deep' }]),
        );

        expect(result.status).toBe(422);
        expect(result.body.error).toEqual({
            code: 'PAGE_OUT_OF_RANGE',
            message: errorMessages.PAGE_OUT_OF_RANGE,
            details: [{ path: 'page', message: 'too deep' }],
            request_id: 'req-1',
        });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ status: 422, code: 'PAGE_OUT_OF_RANGE', method: 'POST' }),
            'request rejected',
        );
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('leaves the request id out when the request has none', () => {
        const result = setup({ method: 'GET', originalUrl: '/' }).render(ApiError.notFound());

        expect(result.body.error.request_id).toBeUndefined();
    });

    it('turns zod validation issues into dotted paths', () => {
        const parsed = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
        const result = setup().render(new ZodValidationException(parsed.error));

        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe('VALIDATION_ERROR');
        expect(result.body.error.details).toEqual([
            expect.objectContaining({ path: 'a.b', code: 'invalid_type' }),
        ]);
    });

    it('answers no details when the validation error carries no issues', () => {
        const result = setup().render(new ZodValidationException({ unexpected: true }));

        expect(result.body.error.details).toEqual([]);
    });

    it('hides a serialization failure behind a 500 and logs it as an error', () => {
        const { render, logger } = setup();
        const result = render(new ZodSerializationException(new Error('shape')));

        expect(result.status).toBe(500);
        expect(result.body.error).toEqual({
            code: 'SERIALIZATION_ERROR',
            message: errorMessages.SERIALIZATION_ERROR,
        });
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ status: 500, url: expect.not.stringContaining('secret') }),
            'request failed',
        );
    });

    it.each([
        ['File too large', 'FILE_TOO_LARGE'],
        ['Too many files', 'FILE_TOO_LARGE'],
        ['Unexpected field', 'FILE_REQUIRED'],
    ])('maps the multer message %p to %p', (message, code) => {
        const result = setup().render(new PayloadTooLargeException(message));

        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe(code);
    });

    it.each([
        [HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED'],
        [HttpStatus.FORBIDDEN, 'FORBIDDEN'],
        [HttpStatus.NOT_FOUND, 'NOT_FOUND'],
        [HttpStatus.CONFLICT, 'CONFLICT'],
        [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_MEDIA_TYPE'],
        [HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED'],
        [HttpStatus.I_AM_A_TEAPOT, 'VALIDATION_ERROR'],
        [HttpStatus.BAD_GATEWAY, 'INTERNAL_ERROR'],
    ])('maps a plain HTTP %p to %p', (status, code) => {
        expect(setup().render(new HttpException('boom', status)).body.error.code).toBe(code);
    });

    it('keeps a string message of a client error and replaces lists and objects with the stock text', () => {
        const { render } = setup();

        expect(render(new BadRequestException('Bad thing')).body.error.message).toBe('Bad thing');
        expect(render(new BadRequestException(['a', 'b'])).body.error.message).toBe(
            errorMessages.VALIDATION_ERROR,
        );
        expect(render(new HttpException({ other: 1 }, HttpStatus.FORBIDDEN)).body.error.message).toBe(
            errorMessages.FORBIDDEN,
        );
        expect(render(new InternalServerErrorException('db password leaked')).body.error.message).toBe(
            errorMessages.INTERNAL_ERROR,
        );
    });

    it('answers 400 for malformed ids', () => {
        const { render } = setup();

        expect(render({ name: 'CastError' }).status).toBe(400);
        expect(render({ name: 'BSONError' }).body.error.code).toBe('VALIDATION_ERROR');
    });

    it('answers 409 for a duplicate key and 500 for any other Mongo failure', () => {
        const { render } = setup();

        expect(render({ name: 'MongoServerError', code: 11000 }).body.error.code).toBe('CONFLICT');
        expect(render({ name: 'MongoServerError', code: 2 }).status).toBe(500);
    });

    it('answers 413 for a body the parser refused as too large', () => {
        const result = setup().render({ type: 'entity.too.large' });

        expect(result.status).toBe(413);
        expect(result.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('answers a generic 500 for anything unknown, including nothing at all', () => {
        const { render } = setup();

        expect(render(new Error('kaboom')).body.error).toEqual({
            code: 'INTERNAL_ERROR',
            message: errorMessages.INTERNAL_ERROR,
        });
        expect(render(undefined).status).toBe(500);
    });
});
