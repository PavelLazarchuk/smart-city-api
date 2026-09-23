import { randomUUID } from 'node:crypto';

import { type BookingPolicy } from '../../src/modules/services/schemas/service.schema';
import { type OptionTree } from '../../src/modules/services/slot.logic';
import { dateOnlyIn, shiftDateOnly } from '../support/dates';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

const ZONE = 'Asia/Tokyo';

const policy = (overrides: Partial<BookingPolicy>): BookingPolicy => ({
    max_active_per_user: null,
    lead_time_minutes: null,
    max_advance_days: null,
    cancel_deadline_minutes: null,
    requires_confirmation: false,
    ...overrides,
});

describe('agent-facing surface (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let client: FixtureUser;
    let bearer: string;
    let admin: FixtureUser;
    let adminBearer: string;

    const optionWith = (slots: OptionTree['slots'], id = randomUUID()): OptionTree => ({
        id,
        label: 'Appointments',
        service_type: 'service_apply',
        enabled: true,
        slots,
    });

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        organization = await fx.organization({ timezone: ZONE, address: 'Chuo 1-1' });
        client = await fx.client({ name: 'Anna', phone: '4915291234567' });
        bearer = await fx.bearer(client);
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
    });

    describe('organization time zone', () => {
        it('is reported on the organization and travels with ?include=organization', async () => {
            const service = await fx.service(organization.id);
            const read = await t.http.get(`${t.prefix}/organizations/${organization.id}`);
            expect(read.status).toBe(200);
            expect(read.body.data.timezone).toBe(ZONE);

            const included = await t.http.get(`${t.prefix}/services/${service.id}?include=organization`);
            expect(included.status).toBe(200);
            expect(included.body.data.organization).toMatchObject({
                timezone: ZONE,
                address: 'Chuo 1-1',
            });
        });

        it('defaults to JOBS_TIMEZONE and refuses a name that is not IANA', async () => {
            const superAdmin = await fx.user({ role: 'super-admin', organization_ids: [] });
            const token = await fx.bearer(superAdmin);
            const created = await t.http
                .post(`${t.prefix}/organizations`)
                .set('Authorization', token)
                .send({ main_label: 'Clinic', main_image: 'https://example.com/i.jpg' });
            expect(created.status).toBe(201);
            expect(created.body.data.timezone).toBe(t.config.jobs.timezone);

            const refused = await t.http.post(`${t.prefix}/organizations`).set('Authorization', token).send({
                main_label: 'Clinic',
                main_image: 'https://example.com/i.jpg',
                timezone: 'Mars/Olympus',
            });
            expect(refused.status).toBe(400);
            expect(refused.body.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('flat slots', () => {
        it('flattens every bookable moment with the zone offset applied and drops what has passed', async () => {
            const today = dateOnlyIn(new Date(), ZONE);
            const option = optionWith([
                {
                    id: randomUUID(),
                    label: 'Today',
                    child_type: 'date_time',
                    value: {
                        date: today,
                        time: [
                            { time: '00:01', limit: 1, booked_count: 0 },
                            { time: '23:59', limit: 1, booked_count: 0 },
                        ],
                    },
                },
                {
                    id: randomUUID(),
                    label: 'Walk in',
                    child_type: 'apply',
                    value: { limit: null, booked_count: 0 },
                },
                {
                    id: randomUUID(),
                    label: 'Not bookable',
                    child_type: 'paycard',
                    value: { limit: null, booked_count: 0 },
                },
            ]);
            const service = await fx.service(organization.id, {
                options: [option],
                duration_minutes: 30,
            });

            const res = await t.http.get(`${t.prefix}/services/${service.id}/slots`);
            expect(res.status).toBe(200);
            expect(res.body.data.timezone).toBe(ZONE);

            const items = res.body.data.items as {
                child_type: string;
                time: string | null;
                starts_at: string | null;
                ends_at: string | null;
            }[];
            expect(items.map((item) => item.child_type)).toEqual(['date_time', 'apply']);

            const timed = items[0]!;
            expect(timed.time).toBe('23:59');
            expect(timed.starts_at).toBe(`${today}T23:59:00+09:00`);
            expect(timed.ends_at).toBe(`${shiftDateOnly(today, 1)}T00:29:00+09:00`);
            expect(items[1]!.starts_at).toBeNull();
        });

        it('filters by window and by availability, and caps the list while reporting the total', async () => {
            const from = shiftDateOnly(dateOnlyIn(new Date(), ZONE), 1);
            const option = optionWith([
                {
                    id: randomUUID(),
                    label: 'Tomorrow',
                    child_type: 'date_time',
                    value: {
                        date: from,
                        time: [
                            { time: '09:00', limit: 1, booked_count: 1 },
                            { time: '10:00', limit: 2, booked_count: 0 },
                            { time: '11:00', limit: null, booked_count: 0 },
                        ],
                    },
                },
            ]);
            const service = await fx.service(organization.id, { options: [option] });
            const base = `${t.prefix}/services/${service.id}/slots`;

            const all = await t.http.get(base);
            expect(all.body.data.total).toBe(3);

            const free = await t.http.get(`${base}?only_available=true`);
            expect(free.body.data.total).toBe(2);
            expect((free.body.data.items as { time: string }[]).map((item) => item.time)).toEqual([
                '10:00',
                '11:00',
            ]);

            const capped = await t.http.get(`${base}?limit=1`);
            expect(capped.body.data.total).toBe(3);
            expect(capped.body.data.items).toHaveLength(1);

            const windowed = await t.http.get(`${base}?after=${from}T10:30:00%2B09:00`);
            expect((windowed.body.data.items as { time: string }[]).map((item) => item.time)).toEqual([
                '11:00',
            ]);
        });

        it('hides an unpublished service from an anonymous caller', async () => {
            const service = await fx.service(organization.id, { status: 'draft', published_at: null });
            const anonymous = await t.http.get(`${t.prefix}/services/${service.id}/slots`);
            expect(anonymous.status).toBe(404);

            const asAdmin = await t.http
                .get(`${t.prefix}/services/${service.id}/slots`)
                .set('Authorization', adminBearer);
            expect(asAdmin.status).toBe(200);
        });
    });

    describe('booking resource', () => {
        it('carries the start instant and the cancel deadline', async () => {
            const date = shiftDateOnly(dateOnlyIn(new Date(), ZONE), 2);
            const option = optionWith([
                {
                    id: randomUUID(),
                    label: 'Slot',
                    child_type: 'date_time',
                    value: { date, time: [{ time: '10:00', limit: 2, booked_count: 0 }] },
                },
            ]);
            const service = await fx.service(organization.id, {
                options: [option],
                booking_policy: policy({ cancel_deadline_minutes: 120 }),
            });
            const created = await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', bearer)
                .send({ option_id: option.id, slot_id: option.slots[0]!.id, time: '10:00' });
            expect(created.status).toBe(201);

            const startsAt = new Date(Date.parse(`${date}T10:00:00+09:00`));
            const mine = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', bearer);
            expect(mine.status).toBe(200);
            expect(mine.body.data[0]).toMatchObject({
                starts_at: startsAt.toISOString(),
                cancel_deadline_at: new Date(startsAt.getTime() - 120 * 60_000).toISOString(),
            });

            const one = await t.http
                .get(`${t.prefix}/bookings/${created.body.data.booking_id}`)
                .set('Authorization', bearer);
            expect(one.body.data.starts_at).toBe(startsAt.toISOString());
        });

        it('leaves the deadline null when the policy sets none', async () => {
            const date = shiftDateOnly(dateOnlyIn(new Date(), ZONE), 2);
            const option = optionWith([
                {
                    id: randomUUID(),
                    label: 'Slot',
                    child_type: 'apply',
                    value: { limit: null, booked_count: 0 },
                },
            ]);
            const service = await fx.service(organization.id, { options: [option] });
            const created = await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', bearer)
                .send({ option_id: option.id, slot_id: option.slots[0]!.id });
            expect(created.status).toBe(201);
            expect(date).toBeDefined();

            const mine = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', bearer);
            expect(mine.body.data[0]).toMatchObject({ starts_at: null, cancel_deadline_at: null });
        });
    });

    describe('client confirmation', () => {
        const pendingService = async () => {
            const date = shiftDateOnly(dateOnlyIn(new Date(), ZONE), 2);
            const option = optionWith([
                {
                    id: randomUUID(),
                    label: 'Slot',
                    child_type: 'date_time',
                    value: { date, time: [{ time: '10:00', limit: 2, booked_count: 0 }] },
                },
            ]);
            const service = await fx.service(organization.id, {
                options: [option],
                booking_policy: policy({ requires_confirmation: true }),
            });
            const created = await t.http
                .post(`${t.prefix}/services/${service.id}/bookings`)
                .set('Authorization', bearer)
                .send({ option_id: option.id, slot_id: option.slots[0]!.id, time: '10:00' });
            expect(created.status).toBe(201);
            expect(created.body.data.status).toBe('pending');

            return created.body.data.booking_id as string;
        };

        it('lets the owner move their own pending booking to confirmed, once', async () => {
            const bookingId = await pendingService();
            const confirmed = await t.http
                .post(`${t.prefix}/bookings/${bookingId}/confirm`)
                .set('Authorization', bearer);
            expect(confirmed.status).toBe(200);
            expect(confirmed.body.data.status).toBe('confirmed');

            const again = await t.http
                .post(`${t.prefix}/bookings/${bookingId}/confirm`)
                .set('Authorization', bearer);
            expect(again.status).toBe(422);
            expect(again.body.error.code).toBe('BOOKING_STATUS_TRANSITION');
        });

        it('hides someone else’s booking behind a 404', async () => {
            const bookingId = await pendingService();
            const stranger = await fx.client({ phone: '4915299999999' });
            const denied = await t.http
                .post(`${t.prefix}/bookings/${bookingId}/confirm`)
                .set('Authorization', await fx.bearer(stranger));
            expect(denied.status).toBe(404);
            expect(denied.body.error.code).toBe('BOOKING_NOT_FOUND');
        });
    });

    describe('search', () => {
        it('falls back to a loose match when the text index scores nothing', async () => {
            await fx.service(organization.id, {
                label: 'Fluorography room',
                value: { heading_value: 'Fluorography room' },
                tags: ['xray'],
            });

            const exact = await t.http.get(`${t.prefix}/services?q=fluorography`);
            expect(exact.body.meta.total).toBe(1);

            const partial = await t.http.get(`${t.prefix}/services?q=fluorograph`);
            expect(partial.body.meta.total).toBe(1);
            expect(partial.body.data[0].label).toBe('Fluorography room');

            const nothing = await t.http.get(`${t.prefix}/services?q=dentistry`);
            expect(nothing.body.meta.total).toBe(0);
        });

        it('reports facets only when asked', async () => {
            const category = await fx.category(organization.id);
            await fx.service(organization.id, { tags: ['xray', 'walkin'], category_id: category.id });
            await fx.service(organization.id, { tags: ['xray'] });

            const without = await t.http.get(`${t.prefix}/services`);
            expect(without.body.meta.facets).toBeUndefined();

            const withFacets = await t.http.get(`${t.prefix}/services?facets=true`);
            expect(withFacets.body.meta.facets.tags).toEqual([
                { value: 'xray', count: 2 },
                { value: 'walkin', count: 1 },
            ]);
            expect(withFacets.body.meta.facets.organizations).toEqual([{ value: organization.id, count: 2 }]);
            expect(withFacets.body.meta.facets.categories).toEqual([{ value: category.id, count: 1 }]);
        });
    });

    describe('provenance and limits', () => {
        it('records the calling client on the analytics event', async () => {
            await t.http
                .get(`${t.prefix}/organizations`)
                .set('User-Agent', 'smart-city-mcp/1.2.3')
                .expect(200);

            const row = await fx
                .collection<{ source?: string }>('AnalyticsEvent')
                .findOne({ type: 'organizations.listed' })
                .lean();
            expect(row?.source).toBe('smart-city-mcp/1.2.3');
        });

        it('counts an authenticated burst against the account, not the address', async () => {
            const first = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', bearer);
            expect(first.status).toBe(200);
            const afterOne = Number(first.headers['ratelimit-remaining']);

            const other = await fx.client({ phone: '4915298888888' });
            const separate = await t.http
                .get(`${t.prefix}/me/bookings`)
                .set('Authorization', await fx.bearer(other));
            expect(Number(separate.headers['ratelimit-remaining'])).toBe(afterOne);

            const same = await t.http.get(`${t.prefix}/me/bookings`).set('Authorization', bearer);
            expect(Number(same.headers['ratelimit-remaining'])).toBe(afterOne - 1);
        });
    });
});
