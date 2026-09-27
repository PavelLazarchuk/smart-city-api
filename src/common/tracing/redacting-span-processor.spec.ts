import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { RedactingSpanProcessor } from './redacting-span-processor';

describe('RedactingSpanProcessor', () => {
    it('hides the calendar token in every url attribute a span starts with', async () => {
        const exporter = new InMemorySpanExporter();
        const provider = new BasicTracerProvider({
            spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor(exporter)],
        });

        provider
            .getTracer('test')
            .startSpan('request', {
                attributes: {
                    'url.full': '/api/v1/me/bookings.ics?token=secret',
                    'url.query': 'token=secret',
                    'http.url': 'http://host/api/v1/me/bookings.ics?a=1&token=secret',
                    'http.target': '/api/v1/me/bookings.ics?token=secret',
                    'url.path': '/api/v1/me/bookings.ics',
                },
            })
            .end();
        await provider.forceFlush();

        const [span] = exporter.getFinishedSpans();
        expect(span?.attributes).toEqual({
            'url.full': '/api/v1/me/bookings.ics?token=[redacted]',
            'url.query': 'token=[redacted]',
            'http.url': 'http://host/api/v1/me/bookings.ics?a=1&token=[redacted]',
            'http.target': '/api/v1/me/bookings.ics?token=[redacted]',
            'url.path': '/api/v1/me/bookings.ics',
        });
    });
});
