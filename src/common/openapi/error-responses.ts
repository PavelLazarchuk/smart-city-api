import { type INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { type OpenAPIObject } from '@nestjs/swagger';

import { ERROR_STATUS, ALL_ERROR_CODES } from '../http/error-status';
import { type ErrorCode, errorMessages } from '../i18n/messages';
import { API_ERRORS_KEY } from './api-errors.decorator';

const ERROR_ENVELOPE = 'ErrorEnvelope';

type Operation = {
    operationId?: string;
    parameters?: { in: string }[];
    requestBody?: unknown;
    security?: unknown[];
    responses?: Record<string, unknown>;
};

const GENERIC: Record<number, ErrorCode[]> = {
    429: ['RATE_LIMITED'],
    500: ['INTERNAL_ERROR', 'SERIALIZATION_ERROR'],
};
const GENERIC_INPUT: ErrorCode[] = ['VALIDATION_ERROR'];
const GENERIC_AUTH: Record<number, ErrorCode[]> = {
    401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED'],
    403: ['FORBIDDEN'],
};

function responseFor(codes: ErrorCode[]): Record<string, unknown> {
    const lines = codes.map((code) => `\`${code}\` — ${errorMessages[code]}`);

    return {
        description: lines.join('\n\n'),
        content: {
            'application/json': {
                schema: {
                    allOf: [
                        { $ref: `#/components/schemas/${ERROR_ENVELOPE}` },
                        {
                            type: 'object',
                            properties: {
                                error: { type: 'object', properties: { code: { enum: codes } } },
                            },
                        },
                    ],
                },
            },
        },
    };
}

export function documentErrorResponses(app: INestApplication, document: OpenAPIObject): OpenAPIObject {
    const declared = collectDeclared(app);
    const components = (document.components ??= {});
    const schemas = (components.schemas ??= {});
    schemas[ERROR_ENVELOPE] = {
        type: 'object',
        required: ['error'],
        properties: {
            error: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                    code: { type: 'string', enum: ALL_ERROR_CODES },
                    message: { type: 'string' },
                    details: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['message'],
                            properties: {
                                path: { type: 'string' },
                                message: { type: 'string' },
                                code: { type: 'string' },
                            },
                        },
                    },
                    request_id: { type: 'string' },
                },
            },
        },
    };

    for (const [path, item] of Object.entries(document.paths)) {
        for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
            const operation = (item as Record<string, Operation | undefined>)[method];

            if (!operation) continue;

            const byStatus = new Map<number, Set<ErrorCode>>();
            const add = (status: number, codes: ErrorCode[]): void => {
                const set = byStatus.get(status) ?? new Set<ErrorCode>();

                for (const code of codes) set.add(code);

                byStatus.set(status, set);
            };

            for (const [status, codes] of Object.entries(GENERIC)) add(Number(status), codes);

            if (operation.requestBody || operation.parameters?.some((p) => p.in === 'query')) {
                add(400, GENERIC_INPUT);
            }

            if (operation.security && operation.security.length > 0) {
                for (const [status, codes] of Object.entries(GENERIC_AUTH)) add(Number(status), codes);
            }

            if (path.includes('{')) add(404, ['NOT_FOUND']);

            for (const code of declared.get(operation.operationId ?? '') ?? [])
                add(ERROR_STATUS[code], [code]);

            operation.responses ??= {};

            for (const [status, codes] of [...byStatus.entries()].sort(([a], [b]) => a - b)) {
                if (operation.responses[String(status)]) continue;

                operation.responses[String(status)] = responseFor([...codes].sort());
            }
        }
    }

    return document;
}

function collectDeclared(app: INestApplication): Map<string, ErrorCode[]> {
    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    const declared = new Map<string, ErrorCode[]>();

    for (const wrapper of discovery.getControllers()) {
        const instance: unknown = wrapper.instance;
        const metatype = wrapper.metatype as { name: string } | null | undefined;

        if (!instance || typeof instance !== 'object' || !metatype) continue;

        const prototype = Object.getPrototypeOf(instance) as object;

        for (const name of scanner.getAllMethodNames(prototype)) {
            const handler = (prototype as Record<string, unknown>)[name];

            if (typeof handler !== 'function') continue;

            const codes = reflector.get<ErrorCode[] | undefined>(API_ERRORS_KEY, handler);

            if (codes && codes.length > 0) declared.set(`${metatype.name}_${name}`, codes);
        }
    }

    return declared;
}
