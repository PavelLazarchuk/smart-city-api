import '../support/throttle-env';
import { Fixtures } from '../support/fixtures';
import { createTestApp } from '../support/test-app';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe('throttling (e2e, mongo storage)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
    });

    it('stores counters in mongo and blocks /auth once the strict limit is exceeded', async () => {
        const attempt = () =>
            t.http.post(`${t.prefix}/auth/login`).send({ login: 'nobody', password: 'wrong-password' });

        const statuses: number[] = [];

        for (let i = 0; i < 5; i += 1) statuses.push((await attempt()).status);

        expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
        expect(statuses.slice(3)).toEqual([429, 429]);

        const rows = await fx.collection<{ total_hits: number }>('RateLimit').find({}).lean();
        expect(rows.length).toBeGreaterThan(0);
        expect(Math.max(...rows.map((row) => row.total_hits))).toBeGreaterThanOrEqual(4);
    });

    it('counts every simultaneous request when the window has just expired', async () => {
        const rateLimits = fx.collection<{ _id: string; total_hits: number; expires_at: Date }>('RateLimit');
        const parallel = 5;
        await t.http.get(`${t.prefix}/organizations`);
        await rateLimits.updateMany({}, { $set: { expires_at: new Date(Date.now() - 1000) } });

        await Promise.all(Array.from({ length: parallel }, () => t.http.get(`${t.prefix}/organizations`)));
        const rows = await rateLimits.find({}).lean();
        expect(Math.max(...rows.map((row) => row.total_hits))).toBe(parallel);
    });

    it('applies the soft global limit to public routes outside /auth', async () => {
        const statuses: number[] = [];

        for (let i = 0; i < 7; i += 1) statuses.push((await t.http.get(`${t.prefix}/organizations`)).status);

        expect(statuses.filter((status) => status === 200)).toHaveLength(5);
        expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    });
});
