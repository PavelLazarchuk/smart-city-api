import { type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { redactUrl } from '../logging/redact-url';

const URL_ATTRIBUTES = ['url.full', 'url.query', 'http.url', 'http.target'];

export class RedactingSpanProcessor implements SpanProcessor {
    onStart(span: Span): void {
        for (const key of URL_ATTRIBUTES) {
            const value = span.attributes[key];

            if (typeof value === 'string') span.setAttribute(key, redactUrl(value));
        }
    }

    onEnd(): void {}

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
