import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { PinoLogger } from 'nestjs-pino';

import { type ErrorCode, errorMessages } from '../i18n/messages';
import { ApiError, type ApiErrorDetail } from './api-error';

interface ErrorEnvelope {
    error: {
        code: string;
        message: string;
        details?: ApiErrorDetail[];
        request_id?: string;
    };
}

interface ZodIssueLike {
    path?: (string | number)[];
    message: string;
    code?: string;
}

function issuesOf(error: unknown): ApiErrorDetail[] {
    const issues = (error as { issues?: ZodIssueLike[] } | undefined)?.issues;

    if (!Array.isArray(issues)) return [];

    return issues.map((issue) => ({
        path: (issue.path ?? []).map(String).join('.'),
        message: issue.message,
        code: issue.code,
    }));
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
    [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
    [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
    [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
    [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
    [HttpStatus.CONFLICT]: 'CONFLICT',
    [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
    [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/**
 * Renders every error as `{ error: { code, message, details?, request_id } }`. Internal errors
 * never leak their message; 4xx are logged at warn, 5xx at error with the stack.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    constructor(private readonly logger: PinoLogger) {
        this.logger.setContext(HttpExceptionFilter.name);
    }

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request & { id?: string }>();
        const { status, body } = this.render(exception);
        const requestId = typeof request.id === 'string' ? request.id : undefined;

        if (requestId) body.error.request_id = requestId;

        const logPayload = {
            status,
            code: body.error.code,
            method: request.method,
            url: request.originalUrl,
        };

        if (status >= 500) {
            this.logger.error({ ...logPayload, err: exception }, 'request failed');
        } else {
            this.logger.warn(logPayload, 'request rejected');
        }

        response.status(status).json(body);
    }

    private render(exception: unknown): { status: number; body: ErrorEnvelope } {
        if (exception instanceof ApiError) {
            return {
                status: exception.getStatus(),
                body: {
                    error: { code: exception.code, message: exception.message, details: exception.details },
                },
            };
        }

        if (exception instanceof ZodValidationException) {
            return {
                status: HttpStatus.BAD_REQUEST,
                body: {
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: errorMessages.VALIDATION_ERROR,
                        details: issuesOf(exception.getZodError()),
                    },
                },
            };
        }

        if (exception instanceof ZodSerializationException) {
            return {
                status: HttpStatus.INTERNAL_SERVER_ERROR,
                body: { error: { code: 'SERIALIZATION_ERROR', message: errorMessages.SERIALIZATION_ERROR } },
            };
        }

        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
            const raw = exception.getResponse();
            const rawMessage = typeof raw === 'object' && raw && 'message' in raw ? raw.message : undefined;
            const message =
                status < 500
                    ? Array.isArray(rawMessage)
                        ? errorMessages[code]
                        : typeof rawMessage === 'string'
                          ? rawMessage
                          : errorMessages[code]
                    : errorMessages.INTERNAL_ERROR;

            return { status, body: { error: { code, message } } };
        }

        const named = exception as { name?: string; code?: number; type?: string } | undefined;

        if (named?.name === 'CastError' || named?.name === 'BSONError') {
            return {
                status: HttpStatus.BAD_REQUEST,
                body: { error: { code: 'VALIDATION_ERROR', message: errorMessages.VALIDATION_ERROR } },
            };
        }

        if (named?.name === 'MongoServerError' && named.code === 11000) {
            return {
                status: HttpStatus.CONFLICT,
                body: { error: { code: 'CONFLICT', message: errorMessages.CONFLICT } },
            };
        }

        if (named?.type === 'entity.too.large') {
            return {
                status: HttpStatus.PAYLOAD_TOO_LARGE,
                body: { error: { code: 'PAYLOAD_TOO_LARGE', message: errorMessages.PAYLOAD_TOO_LARGE } },
            };
        }

        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            body: { error: { code: 'INTERNAL_ERROR', message: errorMessages.INTERNAL_ERROR } },
        };
    }
}
