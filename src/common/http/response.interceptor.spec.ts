import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { type PinoLogger } from 'nestjs-pino';
import { ZodSerializationException } from 'nestjs-zod';
import { firstValueFrom, of } from 'rxjs';
import { z } from 'zod';

import { type MetricsService } from '../metrics/metrics.service';
import { ResponseInterceptor } from './response.interceptor';
import { type SerializeOptions } from './serialize.decorator';

const logged = jest.fn();
const counted = jest.fn();

function run(
    options: SerializeOptions | undefined,
    payload: unknown,
    request: Record<string, unknown> = { route: { path: '/things' } },
): Promise<unknown> {
    const reflector = { get: jest.fn().mockReturnValue(options) } as unknown as Reflector;
    const logger = { setContext: jest.fn(), error: logged } as unknown as PinoLogger;
    const metrics = { countDroppedItems: counted } as unknown as MetricsService;
    const interceptor = new ResponseInterceptor(reflector, logger, metrics);
    const context = {
        getHandler: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(payload) };

    return firstValueFrom(interceptor.intercept(context, next));
}

describe('ResponseInterceptor', () => {
    const schema = z.object({ id: z.string(), name: z.string() });

    it('strips unknown keys and wraps single results', async () => {
        await expect(
            run({ schema, kind: 'single' }, { id: '1', name: 'a', password_hash: 'x' }),
        ).resolves.toEqual({
            data: { id: '1', name: 'a' },
        });
    });

    it('wraps paginated results with meta', async () => {
        await expect(
            run(
                { schema, kind: 'paginated' },
                { items: [{ id: '1', name: 'a', secret: 1 }], total: 1, page: 1, limit: 30 },
            ),
        ).resolves.toEqual({
            data: [{ id: '1', name: 'a' }],
            meta: { page: 1, limit: 30, total: 1, total_pages: 1, has_next: false, dropped: 0 },
        });
    });

    it('passes through when no schema is declared and fails loudly on a schema mismatch', async () => {
        await expect(run(undefined, { anything: true })).resolves.toEqual({ anything: true });
        await expect(run({ schema, kind: 'single' }, { id: 1 })).rejects.toBeInstanceOf(
            ZodSerializationException,
        );
    });

    it('drops a list row the schema rejects, and says so in meta, the log and a metric', async () => {
        logged.mockClear();
        counted.mockClear();
        await expect(
            run({ schema, kind: 'list' }, [{ id: '1', name: 'a' }, { id: 2 }, { id: '3', name: 'c' }]),
        ).resolves.toEqual({
            data: [
                { id: '1', name: 'a' },
                { id: '3', name: 'c' },
            ],
            meta: { dropped: 1 },
        });
        expect(logged).toHaveBeenCalledTimes(1);
        expect(counted).toHaveBeenCalledWith('/things', 1);
    });

    it('picks the schema from the request when the handler declares one', async () => {
        const narrow = z.object({ id: z.string() });
        await expect(
            run(
                { schema: narrow, kind: 'single', schemaFor: () => schema },
                { id: '1', name: 'a', extra: true },
            ),
        ).resolves.toEqual({ data: { id: '1', name: 'a' } });
    });
});
