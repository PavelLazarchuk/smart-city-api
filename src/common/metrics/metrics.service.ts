import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

import { AppConfig } from '../config/app-config';

/**
 * Prometheus registry for the whole process. Metrics are always recorded; `METRICS_ENABLED` only
 * decides whether `/metrics` serves them, so switching the endpoint on needs no restart of the logic.
 */
@Injectable()
export class MetricsService {
    readonly registry = new Registry();

    private readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
    private readonly httpErrors: Counter<'method' | 'route' | 'status_class'>;
    private readonly jobRuns: Counter<'job' | 'result'>;
    private readonly jobDuration: Histogram<'job'>;
    private readonly transactions: Counter<'result'>;
    private readonly transactionAttempts: Counter<string>;
    private readonly smsSent: Counter<'provider' | 'purpose' | 'status'>;
    private readonly smsBudgetBlocked: Counter<'window'>;
    private readonly droppedItems: Counter<'route'>;

    constructor(config: AppConfig) {
        this.registry.setDefaultLabels({ env: config.env, version: config.build.version });
        collectDefaultMetrics({ register: this.registry });

        this.httpDuration = new Histogram({
            name: 'http_request_duration_seconds',
            help: 'HTTP request latency in seconds',
            labelNames: ['method', 'route', 'status'],
            buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [this.registry],
        });
        this.httpErrors = new Counter({
            name: 'http_request_errors_total',
            help: 'HTTP responses with a 4xx or 5xx status',
            labelNames: ['method', 'route', 'status_class'],
            registers: [this.registry],
        });
        this.jobRuns = new Counter({
            name: 'job_runs_total',
            help: 'Scheduled job runs by outcome',
            labelNames: ['job', 'result'],
            registers: [this.registry],
        });
        this.jobDuration = new Histogram({
            name: 'job_duration_seconds',
            help: 'Scheduled job duration in seconds',
            labelNames: ['job'],
            buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
            registers: [this.registry],
        });
        this.transactions = new Counter({
            name: 'db_transactions_total',
            help: 'Database transactions by outcome',
            labelNames: ['result'],
            registers: [this.registry],
        });
        this.transactionAttempts = new Counter({
            name: 'db_transaction_attempts_total',
            help: 'Attempts spent on database transactions, including driver retries',
            registers: [this.registry],
        });
        this.smsSent = new Counter({
            name: 'sms_messages_total',
            help: 'SMS messages by provider, purpose and outcome',
            labelNames: ['provider', 'purpose', 'status'],
            registers: [this.registry],
        });
        this.smsBudgetBlocked = new Counter({
            name: 'sms_budget_blocked_total',
            help: 'SMS refused because the hourly or daily budget was exhausted',
            labelNames: ['window'],
            registers: [this.registry],
        });
        this.droppedItems = new Counter({
            name: 'response_items_dropped_total',
            help: 'List rows dropped because they did not match the response schema',
            labelNames: ['route'],
            registers: [this.registry],
        });
    }

    observeHttp(method: string, route: string, status: number, durationMs: number): void {
        const labels = { method, route, status: String(status) };
        this.httpDuration.observe(labels, durationMs / 1000);

        if (status >= 400) {
            this.httpErrors.inc({ method, route, status_class: status >= 500 ? '5xx' : '4xx' });
        }
    }

    observeJob(job: string, result: 'ok' | 'skipped' | 'failed', durationMs: number): void {
        this.jobRuns.inc({ job, result });
        this.jobDuration.observe({ job }, durationMs / 1000);
    }

    countTransactionAttempt(): void {
        this.transactionAttempts.inc();
    }

    countTransaction(result: 'committed' | 'failed'): void {
        this.transactions.inc({ result });
    }

    countSms(provider: string, purpose: string, status: string): void {
        this.smsSent.inc({ provider, purpose, status });
    }

    countSmsBudgetBlock(window: 'hour' | 'day'): void {
        this.smsBudgetBlocked.inc({ window });
    }

    countDroppedItems(route: string, count: number): void {
        this.droppedItems.inc({ route }, count);
    }

    render(): Promise<string> {
        return this.registry.metrics();
    }

    get contentType(): string {
        return this.registry.contentType;
    }
}
