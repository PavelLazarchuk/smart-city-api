import { Types } from 'mongoose';
import { type PinoLogger } from 'nestjs-pino';

import { type CascadeRegistry } from '../../common/cascade/cascade.registry';
import { type PaginationService } from '../../common/pagination/pagination.service';
import { type AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

function setup(create: jest.Mock = jest.fn().mockResolvedValue({})) {
    const repository = {
        create,
        paginate: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 30 }),
        paginateByCursor: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
        anonymizeUser: jest.fn(),
    };
    const pagination = {
        resolve: jest.fn((query: { limit?: number }) => ({ limit: query.limit ?? 30, page: 1 })),
        maxLimit: 100,
    };
    const cascade = { register: jest.fn() };
    const logger = { setContext: jest.fn(), error: jest.fn() };
    const service = new AnalyticsService(
        repository as unknown as AnalyticsRepository,
        pagination as unknown as PaginationService,
        cascade as unknown as CascadeRegistry,
        logger as unknown as PinoLogger,
    );

    return { service, repository, pagination, cascade, logger };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AnalyticsService', () => {
    it('records the actor, converts known ids and drops empty and malformed ones', () => {
        const { service, repository } = setup();
        const organizationId = new Types.ObjectId().toHexString();

        service.record(
            'organization.viewed',
            {
                organization_id: organizationId,
                service_id: 'not-an-id',
                organization_label: 'Clinic',
                date: undefined,
                time: null as unknown as string,
            },
            {
                id: new Types.ObjectId().toHexString(),
                role: 'common-user',
                organization_ids: [],
                sid: 's',
                name: 'Anna',
                phone: '49152',
            },
        );

        const document = repository.create.mock.calls[0]![0] as Record<string, unknown>;
        expect(document['type']).toBe('organization.viewed');
        expect(document['organization_id']).toBeInstanceOf(Types.ObjectId);
        expect(String(document['organization_id'])).toBe(organizationId);
        expect(document['user_id']).toBeInstanceOf(Types.ObjectId);
        expect(document).toMatchObject({ user_role: 'common-user', user_name: 'Anna', user_phone: '49152' });
        expect(document['organization_label']).toBe('Clinic');
        expect('service_id' in document).toBe(false);
        expect('date' in document).toBe(false);
        expect('time' in document).toBe(false);
    });

    it('records an anonymous event without user fields', () => {
        const { service, repository } = setup();

        service.record('booking.created', { service_label: 'Massage' });

        const document = repository.create.mock.calls[0]![0] as Record<string, unknown>;
        expect('user_id' in document).toBe(false);
        expect(document['service_label']).toBe('Massage');
    });

    it('logs a failed write instead of failing the request', async () => {
        const { service, logger } = setup(jest.fn().mockRejectedValue(new Error('db down')));

        expect(() => service.record('booking.created', {})).not.toThrow();
        await flush();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'booking.created' }),
            'analytics event was not recorded',
        );
    });

    it('builds the filter from every query field and pages by number when asked', async () => {
        const { service, repository } = setup();
        const organizationId = new Types.ObjectId().toHexString();
        const userId = new Types.ObjectId().toHexString();

        await service.list({
            type: 'organization.viewed',
            organization_id: organizationId,
            user_id: userId,
            user_role: 'operator',
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-02-01T00:00:00.000Z',
            page: 2,
        });

        const [filter] = repository.paginate.mock.calls[0]!;
        expect(filter).toEqual({
            type: 'organization.viewed',
            organization_id: new Types.ObjectId(organizationId),
            user_id: new Types.ObjectId(userId),
            user_role: 'operator',
            created_at: {
                $gte: new Date('2026-01-01T00:00:00.000Z'),
                $lte: new Date('2026-02-01T00:00:00.000Z'),
            },
        });
        expect(repository.paginateByCursor).not.toHaveBeenCalled();
    });

    it('bounds only the side of the period that was given', async () => {
        const { service, repository } = setup();

        await service.list({ from: '2026-01-01T00:00:00.000Z', page: 1 });
        await service.list({ to: '2026-01-01T00:00:00.000Z', page: 1 });

        expect(repository.paginate.mock.calls[0]![0]).toEqual({
            created_at: { $gte: new Date('2026-01-01T00:00:00.000Z') },
        });
        expect(repository.paginate.mock.calls[1]![0]).toEqual({
            created_at: { $lte: new Date('2026-01-01T00:00:00.000Z') },
        });
    });

    it('scrolls by cursor by default, capping the limit and counting only on request', async () => {
        const { service, repository } = setup();
        const cursor = new Types.ObjectId().toHexString();

        await service.list({});
        await service.list({ cursor, limit: 500, with_total: true });

        expect(repository.paginateByCursor.mock.calls[0]).toEqual([{}, undefined, 30, false]);
        expect(repository.paginateByCursor.mock.calls[1]).toEqual([{}, cursor, 100, true]);
        expect(repository.paginate).not.toHaveBeenCalled();
    });

    it('anonymises the events of a deleted account through the cascade', async () => {
        const { service, cascade, repository } = setup();

        service.onModuleInit();
        const [, name, handler] = cascade.register.mock.calls[0] as [
            string,
            string,
            (id: string, ctx: { session: unknown }) => Promise<void>,
        ];
        await handler('user-1', { session: 'tx' });

        expect(name).toBe('analytics.anonymize');
        expect(repository.anonymizeUser).toHaveBeenCalledWith('user-1', 'tx');
    });
});
