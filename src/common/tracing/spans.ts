import {
    type Attributes,
    type Context,
    context,
    propagation,
    ROOT_CONTEXT,
    type Span,
    type SpanKind,
    SpanStatusCode,
    trace,
} from '@opentelemetry/api';

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;
const TRACEPARENT_HEADER = 'traceparent';

export type TraceCarrier = Record<string, string>;

export interface SpanOptions {
    kind?: SpanKind;
    attributes?: Attributes;
    parent?: Context;
}

export const tracer = trace.getTracer('smart-city-api');

export function inSpan<T>(name: string, options: SpanOptions, work: (span: Span) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(
        name,
        { kind: options.kind, attributes: options.attributes },
        options.parent ?? context.active(),
        async (span) => {
            try {
                return await work(span);
            } catch (error) {
                span.recordException(error instanceof Error ? error : String(error));
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error),
                });
                throw error;
            } finally {
                span.end();
            }
        },
    );
}

export function detached<T>(work: () => T): T {
    return context.with(ROOT_CONTEXT, work);
}

export function currentTraceCarrier(): TraceCarrier | null {
    const carrier: TraceCarrier = {};
    propagation.inject(context.active(), carrier);
    const traceparent = carrier[TRACEPARENT_HEADER];

    return traceparent ? { [TRACEPARENT_HEADER]: traceparent } : null;
}

export function contextOf(carrier: TraceCarrier | null | undefined): Context {
    return carrier ? propagation.extract(ROOT_CONTEXT, carrier) : ROOT_CONTEXT;
}

export function traceIdOf(carrier: TraceCarrier | null | undefined): string | null {
    const traceparent = carrier?.[TRACEPARENT_HEADER];

    return typeof traceparent === 'string' ? (TRACEPARENT.exec(traceparent)?.[1] ?? null) : null;
}
