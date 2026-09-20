import { HttpException, HttpStatus } from '@nestjs/common';

import { type ErrorCode, errorMessages } from '../i18n/messages';

export interface ApiErrorDetail {
    path?: string;
    message: string;
    [key: string]: unknown;
}

export class ApiError extends HttpException {
    readonly code: ErrorCode;
    readonly details: ApiErrorDetail[] | undefined;

    constructor(status: HttpStatus, code: ErrorCode, details?: ApiErrorDetail[], message?: string) {
        super({ code, message: message ?? errorMessages[code], details }, status);
        this.code = code;
        this.details = details;
    }

    static badRequest(code: ErrorCode = 'VALIDATION_ERROR', details?: ApiErrorDetail[]): ApiError {
        return new ApiError(HttpStatus.BAD_REQUEST, code, details);
    }

    static unauthorized(code: ErrorCode = 'UNAUTHENTICATED'): ApiError {
        return new ApiError(HttpStatus.UNAUTHORIZED, code);
    }

    static forbidden(code: ErrorCode = 'FORBIDDEN'): ApiError {
        return new ApiError(HttpStatus.FORBIDDEN, code);
    }

    static notFound(code: ErrorCode = 'NOT_FOUND'): ApiError {
        return new ApiError(HttpStatus.NOT_FOUND, code);
    }

    static conflict(code: ErrorCode = 'CONFLICT'): ApiError {
        return new ApiError(HttpStatus.CONFLICT, code);
    }

    static unprocessable(code: ErrorCode, details?: ApiErrorDetail[]): ApiError {
        return new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, code, details);
    }
}
