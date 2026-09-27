import { context, propagation, trace } from '@opentelemetry/api';
import { W3CBaggagePropagator, CompositePropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { contextOf, currentTraceCarrier, detached, inSpan, traceIdOf } from './spans';

describe('spans', () => {
    const exporter = new InMemorySpanExporter();
    const manager = new AsyncLocalStorageContextManager();

    beforeAll(() => {
        context.setGlobalContextManager(manager.enable());
        propagation.setGlobalPropagator(new W3CTraceContextPropagator());
        trace.setGlobalTracerProvider(
            new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
        );
    });
    afterAll(() => {
        trace.disable();
        propagation.disable();
        context.disable();
    });
    beforeEach(() => exporter.reset());

    it('reads the trace id out of a traceparent and refuses anything else', () => {
        expect(traceIdOf({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' })).toBe(
            '0af7651916cd43dd8448eb211c80319c',
        );
        expect(traceIdOf({ traceparent: 'garbage' })).toBeNull();
        expect(traceIdOf(null)).toBeNull();
    });

    it('captures the active span and continues it later as a parent', async () => {
        const carrier = await inSpan('request', {}, () => Promise.resolve(currentTraceCarrier()));
        expect(currentTraceCarrier()).toBeNull();

        await detached(() => inSpan('delivery', { parent: contextOf(carrier) }, () => Promise.resolve()));

        const [request, delivery] = exporter.getFinishedSpans();
        expect(delivery?.spanContext().traceId).toBe(request?.spanContext().traceId);
        expect(delivery?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
        expect(traceIdOf(carrier)).toBe(request?.spanContext().traceId);
    });

    it('keeps only the traceparent, so client baggage never reaches the outbox', async () => {
        propagation.disable();
        propagation.setGlobalPropagator(
            new CompositePropagator({
                propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
            }),
        );

        try {
            const baggage = propagation.createBaggage({ note: { value: 'x'.repeat(1000) } });
            const carrier = await context.with(propagation.setBaggage(context.active(), baggage), () =>
                inSpan('request', {}, () => Promise.resolve(currentTraceCarrier())),
            );

            expect(Object.keys(carrier ?? {})).toEqual(['traceparent']);
        } finally {
            propagation.disable();
            propagation.setGlobalPropagator(new W3CTraceContextPropagator());
        }
    });

    it('marks a failed span and rethrows', async () => {
        await expect(inSpan('failing', {}, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

        const [span] = exporter.getFinishedSpans();
        expect(span?.status).toMatchObject({ code: 2, message: 'boom' });
        expect(span?.events.map((event) => event.name)).toContain('exception');
    });
});
