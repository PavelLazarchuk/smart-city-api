import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { ZodSerializationException } from 'nestjs-zod';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, map } from 'rxjs';
import { type ZodType } from 'zod';

import { MetricsService } from '../metrics/metrics.service';
import { routeOf } from '../metrics/route-of';
import { isPaginatedResult, type PaginatedResult, paginationMeta } from '../pagination/paginated-result';
import { normalize } from './normalize';
import { SERIALIZE_METADATA, type SerializeOptions } from './serialize.decorator';

interface ParsedItems {
    items: unknown[];
    dropped: number;
}

/**
 * Applies the handler's `@Serialize()` schema and wraps the result in the response envelope:
 * `{ data }` for single entities and lists, `{ data, meta }` for paginated results.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly logger: PinoLogger,
        private readonly metrics?: MetricsService,
    ) {
        this.logger.setContext(ResponseInterceptor.name);
    }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const options = this.reflector.get<SerializeOptions | undefined>(
            SERIALIZE_METADATA,
            context.getHandler(),
        );

        if (!options) return next.handle();

        const request = context.switchToHttp().getRequest<Request | undefined>();

        return next.handle().pipe(map((payload) => this.render(payload, options, request)));
    }

    private render(payload: unknown, options: SerializeOptions, request?: Request): unknown {
        if (payload === undefined || payload === null) return payload;

        const schema = this.schemaFor(options, request);

        if (options.kind === 'paginated') {
            if (!isPaginatedResult(payload))
                throw new ZodSerializationException(new Error('Expected a paginated result'));

            const result: PaginatedResult<unknown> = payload;
            const parsed = this.parseItems(schema, result.items, request);

            return { data: parsed.items, meta: { ...paginationMeta(result), dropped: parsed.dropped } };
        }

        if (options.kind === 'list') {
            if (!Array.isArray(payload)) throw new ZodSerializationException(new Error('Expected an array'));

            const parsed = this.parseItems(schema, payload, request);

            return parsed.dropped > 0
                ? { data: parsed.items, meta: { dropped: parsed.dropped } }
                : { data: parsed.items };
        }

        return { data: this.parse(schema, payload) };
    }

    private schemaFor({ schema, schemaFor }: SerializeOptions, request?: Request): ZodType {
        return schemaFor && request ? schemaFor(request) : schema;
    }

    /**
     * A legacy row the current schema rejects is dropped and logged rather than failing the whole page.
     * Single-entity responses still fail loudly, because there the row *is* the response.
     */
    private parseItems(schema: ZodType, items: unknown[], request?: Request): ParsedItems {
        const parsed: unknown[] = [];
        let dropped = 0;

        for (const item of items) {
            const result = schema.safeParse(normalize(item));

            if (result.success) {
                parsed.push(result.data);
                continue;
            }

            dropped += 1;
            this.logger.error(
                { issues: result.error.issues.map((issue) => issue.path.map(String).join('.')) },
                'list item dropped: it does not match the response schema',
            );
        }

        if (dropped > 0) this.metrics?.countDroppedItems(request ? routeOf(request) : 'unmatched', dropped);

        return { items: parsed, dropped };
    }

    private parse(schema: ZodType, value: unknown): unknown {
        const result = schema.safeParse(normalize(value));

        if (!result.success) throw new ZodSerializationException(result.error);

        return result.data;
    }
}
