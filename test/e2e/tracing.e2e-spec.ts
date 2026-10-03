import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { OutboxService } from '../../src/common/outbox/outbox.service';
import { BookingRemindersJob } from '../../src/jobs/booking-reminders.job';
import { waitFor } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('tracing from a request or a job to the deferred delivery (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let client: FixtureUser;
    let option: ReturnType<Fixtures['bookableOption']>;
    let serviceId: string;
    const exporter = new InMemorySpanExporter();

    beforeAll(async () => {
        context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
        propagation.setGlobalPropagator(new W3CTraceContextPropagator());
        trace.setGlobalTracerProvider(
            new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
        );
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(async () => {
        await t.close();
        trace.disable();
        propagation.disable();
        context.disable();
    });
    beforeEach(async () => {
        await t.clearDatabase();
        exporter.reset();
        organization = await fx.organization();
        client = await fx.client();
        option = fx.bookableOption();
        serviceId = (await fx.service(organization.id, { options: [option] })).id;
    });

    it('stamps an event with the request id, so an admin can find what one request queued', async () => {
        const created = await t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', await fx.bearer(client))
            .set('X-Request-Id', 'req-trace-0001')
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        expect(created.status).toBe(201);

        const stored = await fx
            .collection<{ request_id: string | null }>('OutboxEvent')
            .findOne({ type: 'booking.created' })
            .lean();
        expect(stored?.request_id).toBe('req-trace-0001');

        const admin = await fx.bearer(await fx.admin([organization.id]));
        const found = await t.http
            .get(`${t.prefix}/outbox/events?request_id=req-trace-0001`)
            .set('Authorization', admin);
        expect(found.status).toBe(200);
        expect(found.body.data).toHaveLength(1);
        expect(found.body.data[0]).toMatchObject({ type: 'booking.created', request_id: 'req-trace-0001' });

        const other = await t.http
            .get(`${t.prefix}/outbox/events?request_id=req-trace-9999`)
            .set('Authorization', admin);
        expect(other.body.data).toHaveLength(0);
    });

    it('delivers a reminder inside the trace of the job run that queued it', async () => {
        await t.http
            .post(`${t.prefix}/services/${serviceId}/bookings`)
            .set('Authorization', await fx.bearer(client))
            .send({ option_id: option.id, slot_id: option.slot_id, time: '10:00' });
        const starts = await fx.collection<{ starts_at: Date }>('Booking').findOne({}).lean();
        exporter.reset();

        await t.app.get(BookingRemindersJob).run(new Date(starts!.starts_at.getTime() - 3_600_000));
        await t.app.get(OutboxService).dispatch();
        await waitFor(() =>
            Promise.resolve(
                exporter.getFinishedSpans().some((span) => span.name === 'outbox booking.reminder'),
            ),
        );

        const spans = exporter.getFinishedSpans();
        const job = spans.find((span) => span.name === 'job booking_reminders');
        const delivery = spans.find((span) => span.name === 'outbox booking.reminder');
        const attempts = spans.filter(
            (span) =>
                span.name === 'outbox deliver handler' &&
                span.parentSpanContext?.spanId === delivery?.spanContext().spanId,
        );
        const sms = spans.find((span) => span.name === 'sms send');

        expect(job?.attributes['job.result']).toBe('ok');
        expect(delivery?.spanContext().traceId).toBe(job?.spanContext().traceId);
        expect(delivery?.parentSpanContext?.spanId).toBe(job?.spanContext().spanId);
        expect(delivery?.attributes).toMatchObject({
            'outbox.event_type': 'booking.reminder',
            'outbox.outcome': 'delivered',
        });
        expect(attempts.map((span) => span.attributes['outbox.target']).sort()).toEqual([
            'handler:inbox',
            'handler:mail',
            'handler:sms',
        ]);
        expect(sms?.spanContext().traceId).toBe(job?.spanContext().traceId);

        const stored = await fx
            .collection<{ trace: Record<string, string> | null }>('OutboxEvent')
            .findOne({ type: 'booking.reminder' })
            .lean();
        const admin = await fx.bearer(await fx.superAdmin());
        const listed = await t.http
            .get(`${t.prefix}/outbox/events?type=booking.reminder`)
            .set('Authorization', admin);
        expect(stored?.trace?.['traceparent']).toContain(job!.spanContext().traceId);
        expect(listed.body.data[0].trace_id).toBe(job?.spanContext().traceId);
    });
});
