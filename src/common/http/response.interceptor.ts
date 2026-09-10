import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ZodSerializationException } from 'nestjs-zod';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, map } from 'rxjs';
import { type ZodType } from 'zod';

import { isPaginatedResult, type PaginatedResult, paginationMeta } from '../pagination/paginated-result';
import { normalize } from './normalize';
import { SERIALIZE_METADATA, type SerializeOptions } from './serialize.decorator';

/**
 * Applies the handler's `@Serialize()` schema and wraps the result in the response envelope:
 * `{ data }` for single entities and lists, `{ data, meta }` for paginated results.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(ResponseInterceptor.name);
    }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const options = this.reflector.get<SerializeOptions | undefined>(
            SERIALIZE_METADATA,
            context.getHandler(),
        );

        if (!options) return next.handle();

        return next.handle().pipe(map((payload) => this.render(payload, options)));
    }

    private render(payload: unknown, { schema, kind }: SerializeOptions): unknown {
        if (payload === undefined || payload === null) return payload;

        if (kind === 'paginated') {
            if (!isPaginatedResult(payload))
                throw new ZodSerializationException(new Error('Expected a paginated result'));

            const result: PaginatedResult<unknown> = payload;

            return { data: this.parseItems(schema, result.items), meta: paginationMeta(result) };
        }

        if (kind === 'list') {
            if (!Array.isArray(payload)) throw new ZodSerializationException(new Error('Expected an array'));

            return { data: this.parseItems(schema, payload) };
        }

        return { data: this.parse(schema, payload) };
    }

    /**
     * A legacy row the current schema rejects is dropped and logged rather than failing the whole page.
     * Single-entity responses still fail loudly, because there the row *is* the response.
     */
    private parseItems(schema: ZodType, items: unknown[]): unknown[] {
        const parsed: unknown[] = [];

        for (const item of items) {
            const result = schema.safeParse(normalize(item));

            if (result.success) {
                parsed.push(result.data);
                continue;
            }

            this.logger.error(
                { issues: result.error.issues.map((issue) => issue.path.map(String).join('.')) },
                'list item dropped: it does not match the response schema',
            );
        }

        return parsed;
    }

    private parse(schema: ZodType, value: unknown): unknown {
        const result = schema.safeParse(normalize(value));

        if (!result.success) throw new ZodSerializationException(result.error);

        return result.data;
    }
}
