import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { existsSync } from 'node:fs';
import { IncomingMessage } from 'node:http';

import { type TracingEnv, tracingEnvSchema } from '../config/env.schema';
import { resolveRequestId } from '../context/request-id';
import { RedactingSpanProcessor } from './redacting-span-processor';

const UNTRACED = ['health', 'metrics'];

let provider: NodeTracerProvider | null = null;

function untraced(prefix: string): (request: IncomingMessage) => boolean {
    const paths = UNTRACED.map((path) => `/${prefix}/${path}`);

    return (request) => {
        const path = (request.url ?? '').split('?')[0] ?? '';

        return paths.some((untracedPath) => path === untracedPath || path.startsWith(`${untracedPath}/`));
    };
}

export function tracingEnv(env: NodeJS.ProcessEnv = process.env): TracingEnv | null {
    if (env['NODE_ENV'] !== 'test' && existsSync('.env')) process.loadEnvFile('.env');

    const parsed = tracingEnvSchema.safeParse(env);

    return parsed.success ? parsed.data : null;
}

export function startTracing(env: TracingEnv | null = tracingEnv()): boolean {
    if (!env?.TRACING_ENABLED || provider) return false;

    const prefix = env.API_PREFIX.replace(/^\/+|\/+$/g, '');
    provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: env.BUILD_VERSION ?? '1.0.0',
            'deployment.environment.name': env.NODE_ENV,
        }),
        spanProcessors: [new RedactingSpanProcessor(), new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    provider.register({ propagator: new W3CTraceContextPropagator() });
    registerInstrumentations({
        tracerProvider: provider,
        instrumentations: [
            new HttpInstrumentation({
                ignoreIncomingRequestHook: untraced(prefix),
                redactedQueryParamsServer: ['token'],
                requestHook: (span, request) => {
                    if (request instanceof IncomingMessage)
                        span.setAttribute('request_id', resolveRequestId(request));
                },
            }),
            new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
            new NestInstrumentation(),
            new MongoDBInstrumentation(),
            new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
            new UndiciInstrumentation(),
            new PinoInstrumentation({ disableLogSending: true }),
        ],
    });

    return true;
}

export async function stopTracing(): Promise<void> {
    const current = provider;
    provider = null;

    await current?.shutdown();
}
