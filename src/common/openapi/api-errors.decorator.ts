import { applyDecorators, SetMetadata } from '@nestjs/common';

import { type ErrorCode } from '../i18n/messages';

export const API_ERRORS_KEY = 'smart_city:api_errors';

export const ApiErrors = (...codes: ErrorCode[]): MethodDecorator =>
    applyDecorators(SetMetadata<string, ErrorCode[]>(API_ERRORS_KEY, codes));
