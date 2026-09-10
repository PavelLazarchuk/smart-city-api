import { Types } from 'mongoose';

import { ConsoleMailProvider } from '../../src/integrations/mail/console-mail.provider';
import { DebtorReportJob } from '../../src/jobs/debtor-report.job';
import { JobLockService } from '../../src/jobs/job-lock.service';
import { JobRunner } from '../../src/jobs/job-runner';
import { NewsExpiryJob } from '../../src/jobs/news-expiry.job';
import { RecurrentSlotsJob } from '../../src/jobs/recurrent-slots.job';
import { SlotExpiryJob } from '../../src/jobs/slot-expiry.job';
import { StaleBookingsJob } from '../../src/jobs/stale-bookings.job';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('jobs (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(() => t.clearDatabase());

    describe('job_locks', () => {
        it('two workers with one due job → exactly one execution; an expired lease is re-acquirable', async () => {
            const locks = t.app.get(JobLockService);
            const runner = t.app.get(JobRunner);
            let executions = 0;
            const work = async (): Promise<void> => {
                executions += 1;
                await new Promise((resolve) => setTimeout(resolve, 200));
            };
            const outcomes = await Promise.all([runner.run('demo', work), runner.run('demo', work)]);
            expect(executions).toBe(1);
            expect(outcomes.map((outcome) => outcome.ran).sort()).toEqual([false, true]);

            const lease = await locks.acquire('demo');
            expect(lease).not.toBeNull();
            await fx
                .collection('JobLock')
                .updateOne(
                    { _id: 'demo' },
                    { $set: { locked_until: new Date(Date.now() - 1000), holder: 'dead' } },
                );
            const reacquired = await locks.acquire('demo');
            expect(reacquired?.holder).toBe(locks.holderId);
            await fx
                .collection('JobLock')
                .updateOne(
                    { _id: 'demo' },
                    { $set: { locked_until: new Date(Date.now() + 60_000), holder: 'other' } },
                );
            expect(await locks.acquire('demo')).toBeNull();
        });
    });

    describe('recurrent slots', () => {
        it('generates date_time slots over the horizon, idempotently, in one bulk write', async () => {
            const organization = await fx.organization();
            const service = await fx.service(organization.id, {
                options: [
                    {
                        id: '11111111-1111-4111-8111-111111111111',
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        recurrent_dates: [
                            { day: 'monday', time: [{ time: '09:00', limit: 2 }] },
                            { day: 'friday', time: [{ time: '15:00', limit: null }] },
                        ],
                        slots: [],
                    },
                ],
            });
            const job = t.app.get(RecurrentSlotsJob);
            const now = new Date(2026, 8, 5);
            expect(await job.execute(now)).toEqual({ services_updated: 1 });
            const stored = await fx
                .collection<{
                    options: {
                        slots: {
                            child_type: string;
                            value: { date: string; time: { time: string; limit: number | null }[] };
                        }[];
                    }[];
                }>('Service')
                .findById(service.id)
                .lean();
            const slots = stored!.options[0]!.slots;
            expect(slots).toHaveLength(9);
            expect(slots.every((slot) => slot.child_type === 'date_time')).toBe(true);
            expect(slots[0]!.value).toMatchObject({
                date: '2026-09-07',
                time: [{ time: '09:00', limit: 2 }],
            });
            expect(await job.execute(now)).toEqual({ services_updated: 0 });
        });

        it('updates slots in place: existing bookings and their times survive', async () => {
            const organization = await fx.organization();
            const citizen = await fx.citizen();
            const optionId = '11111111-1111-4111-8111-111111111111';
            const slotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            const service = await fx.service(organization.id, {
                options: [
                    {
                        id: optionId,
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        recurrent_dates: [{ day: 'monday', time: [{ time: '09:00', limit: 2 }] }],
                        slots: [
                            {
                                id: slotId,
                                label: 'd',
                                child_type: 'date_time',
                                value: {
                                    date: '2026-09-07',
                                    time: [
                                        {
                                            time: '18:00',
                                            limit: null,
                                            booked_count: 1,
                                            bookings: [
                                                {
                                                    id: '22222222-2222-4222-8222-222222222222',
                                                    user_id: new Types.ObjectId(citizen.id),
                                                    person: 'Anna',
                                                    phone: '375291112233',
                                                    info: '',
                                                    created_at: new Date(),
                                                },
                                            ],
                                        },
                                        { time: '20:00', limit: null, booked_count: 0, bookings: [] },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            });

            expect(await t.app.get(RecurrentSlotsJob).execute(new Date(2026, 8, 5))).toEqual({
                services_updated: 1,
            });
            const stored = await fx
                .collection<{
                    options: {
                        slots: {
                            id: string;
                            value: {
                                date: string;
                                time: { time: string; booked_count: number; bookings: unknown[] }[];
                            };
                        }[];
                    }[];
                }>('Service')
                .findById(service.id)
                .lean();
            const slot = stored!.options[0]!.slots.find((item) => item.id === slotId)!;
            const times = slot.value.time.map((entry) => entry.time);
            expect(times).toContain('09:00');
            expect(times).toContain('18:00');
            expect(times).not.toContain('20:00');
            const booked = slot.value.time.find((entry) => entry.time === '18:00')!;
            expect(booked).toMatchObject({ booked_count: 1 });
            expect(booked.bookings).toHaveLength(1);
        });
    });

    describe('expiry jobs', () => {
        it('archives expired news transactionally', async () => {
            const organization = await fx.organization();
            const expired = await fx.news(organization.id, { expires_at: new Date('2020-01-01T00:00:00Z') });
            await fx.news(organization.id, { expires_at: new Date('2999-01-01T00:00:00Z') });
            await fx.news(organization.id);
            expect(await t.app.get(NewsExpiryJob).execute(new Date())).toEqual({ archived: 1 });
            expect(await fx.collection('News').countDocuments({})).toBe(2);
            const archives = await fx
                .collection<{ type: string; data: { _id: string } }>('Archive')
                .find({})
                .lean();
            expect(archives).toHaveLength(1);
            expect(archives[0]!.type).toBe('news');
            expect(archives[0]!.data._id).toBe(expired.id);
        });

        it('archives expired dated slots and drops the users’ references', async () => {
            const organization = await fx.organization();
            const citizen = await fx.citizen();
            const bookingId = '22222222-2222-4222-8222-222222222222';
            const service = await fx.service(organization.id, {
                options: [
                    {
                        id: '11111111-1111-4111-8111-111111111111',
                        label: 'x',
                        service_type: 'service_apply',
                        enabled: true,
                        slots: [
                            {
                                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                label: 'old',
                                child_type: 'date',
                                value: {
                                    date: '2020-01-01',
                                    limit: null,
                                    booked_count: 1,
                                    bookings: [
                                        {
                                            id: bookingId,
                                            user_id: new Types.ObjectId(citizen.id),
                                            person: '',
                                            phone: '',
                                            info: '',
                                            created_at: new Date(),
                                        },
                                    ],
                                },
                            },
                            {
                                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                                label: 'future',
                                child_type: 'date',
                                value: { date: '2999-01-01', limit: null, booked_count: 0, bookings: [] },
                            },
                            {
                                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                                label: 'apply',
                                child_type: 'apply',
                                value: { limit: null, booked_count: 0, bookings: [] },
                            },
                        ],
                    },
                ],
            });
            await fx.collection('User').updateOne(
                { _id: new Types.ObjectId(citizen.id) },
                {
                    $set: {
                        bookings: [
                            {
                                id: bookingId,
                                service_id: new Types.ObjectId(service.id),
                                organization_id: new Types.ObjectId(organization.id),
                                option_id: '11111111-1111-4111-8111-111111111111',
                                slot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                child_type: 'date',
                                created_at: new Date(),
                            },
                        ],
                    },
                },
            );
            expect(await t.app.get(SlotExpiryJob).execute(new Date())).toEqual({
                services_updated: 1,
                slots_archived: 1,
            });
            const stored = await fx
                .collection<{ options: { slots: { id: string }[] }[] }>('Service')
                .findById(service.id)
                .lean();
            expect(stored!.options[0]!.slots.map((slot) => slot.id)).toEqual([
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            ]);
            expect(
                await fx
                    .collection('Archive')
                    .countDocuments({ type: 'service', service_id: new Types.ObjectId(service.id) }),
            ).toBe(1);
            const user = await fx.collection<{ bookings: unknown[] }>('User').findById(citizen.id).lean();
            expect(user!.bookings).toEqual([]);
        });

        it('stale booking cleanup drops references whose slot no longer exists', async () => {
            const organization = await fx.organization();
            const citizen = await fx.citizen();
            const service = await fx.service(organization.id, { options: [] });
            await fx.collection('User').updateOne(
                { _id: new Types.ObjectId(citizen.id) },
                {
                    $set: {
                        bookings: [
                            {
                                id: 'gone-1',
                                service_id: new Types.ObjectId(service.id),
                                organization_id: new Types.ObjectId(organization.id),
                                option_id: 'o',
                                slot_id: 's',
                                child_type: 'apply',
                                created_at: new Date(),
                            },
                        ],
                    },
                },
            );
            expect(await t.app.get(StaleBookingsJob).execute()).toEqual({
                users_updated: 1,
                references_removed: 1,
            });
            expect(await t.app.get(StaleBookingsJob).execute()).toEqual({
                users_updated: 0,
                references_removed: 0,
            });
        });
    });

    describe('debtor report', () => {
        it('lists apply options without upcoming slots and mails an xlsx attachment', async () => {
            const organization = await fx.organization({ main_label: 'Clinic', main_category: 'healthcare' });
            const ignored = await fx.organization({ main_label: 'No category', main_category: undefined });
            const base = { id: 'o', label: 'x', service_type: 'service_apply' as const, enabled: true };
            await fx.service(organization.id, {
                value: { heading_value: 'Empty option' },
                options: [{ ...base, slots: [] }],
            });
            await fx.service(organization.id, {
                value: { heading_value: 'Only past' },
                options: [
                    {
                        ...base,
                        slots: [
                            {
                                id: 's',
                                label: 'd',
                                child_type: 'date',
                                value: { date: '2000-01-01', limit: null, booked_count: 0, bookings: [] },
                            },
                        ],
                    },
                ],
            });
            await fx.service(organization.id, {
                value: { heading_value: 'Has future' },
                options: [
                    {
                        ...base,
                        slots: [
                            {
                                id: 's',
                                label: 'd',
                                child_type: 'date',
                                value: { date: '2999-01-01', limit: null, booked_count: 0, bookings: [] },
                            },
                        ],
                    },
                ],
            });
            await fx.service(organization.id, {
                value: { heading_value: 'Recurrent' },
                options: [{ ...base, recurrent_dates: [{ day: 'monday', time: [] }], slots: [] }],
            });
            await fx.service(ignored.id, {
                value: { heading_value: 'Ignored' },
                options: [{ ...base, slots: [] }],
            });

            const mail = jest.spyOn(t.app.get(ConsoleMailProvider), 'send').mockResolvedValue(undefined);
            const job = t.app.get(DebtorReportJob);
            const rows = await job.collect(new Date());
            expect(rows.map((row) => row.service).sort()).toEqual(['Empty option', 'Only past']);
            expect(await job.execute(new Date())).toEqual({ rows: 2, recipients: 1 });
            const message = mail.mock.calls[0]![0] as {
                to: string[];
                attachments: { filename: string; content: Buffer }[];
            };
            expect(message.to).toEqual(['reports@example.com']);
            expect(message.attachments[0]!.filename).toMatch(/\.xlsx$/);
            expect(message.attachments[0]!.content.length).toBeGreaterThan(1000);
            mail.mockRestore();
        });
    });
});
