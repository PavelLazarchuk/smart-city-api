const API = (process.env['SMOKE_API_URL'] ?? 'http://localhost:8080/api/v1').replace(/\/$/, '');
const ADMIN = {
    login: process.env['SMOKE_ADMIN_LOGIN'] ?? 'cityadmin',
    password: process.env['SMOKE_ADMIN_PASSWORD'] ?? 'Cityadmin-Pass1',
};
const CLIENT_PASSWORD = 'Smoke-Client-Pass1';
const RUN = String(Math.floor(Math.random() * 90) + 10);

interface SlotData {
    id: string;
    label: string;
    range?: { free: { from: string; to: string }[] };
}

interface Data {
    id: string;
    access_token: string;
    user: { organization_ids: string[] };
    options: { id: string; slots: SlotData[] }[];
    booking_id: string;
    time: string | null;
    end_time: string | null;
    address: string | null;
    moved: number;
}

interface Reply {
    status: number;
    body: { data: Data; error?: { code?: string } };
}

let passed = 0;
let failed = 0;
let phones = 0;

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();

    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Reply['body'] };
}

function check(name: string, actual: unknown, expected: unknown): void {
    const same = JSON.stringify(actual) === JSON.stringify(expected);

    if (same) passed += 1;
    else failed += 1;

    console.log(
        same
            ? `  ok   ${name}`
            : `  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

function outcome(reply: Reply): string {
    return `${reply.status}${reply.body.error?.code ? ` ${reply.body.error.code}` : ''}`;
}

function at<T>(items: T[], index: number): T {
    const item = items[index];

    if (item === undefined) throw new Error(`no item at ${index}`);

    return item;
}

function dateIn(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function client(): Promise<string> {
    phones += 1;
    const phone = `491529${RUN}${String(phones).padStart(5, '0')}`;
    const reply = await call('POST', '/auth/register', undefined, {
        phone,
        password: CLIENT_PASSWORD,
        name: `Smoke ${phone}`,
    });

    if (reply.status !== 201) throw new Error(`register ${phone}: ${outcome(reply)}`);

    return reply.body.data.access_token;
}

async function main(): Promise<void> {
    const login = await call('POST', '/auth/login', undefined, ADMIN);

    if (login.status !== 200) throw new Error(`admin login: ${outcome(login)}`);

    const admin = login.body.data.access_token;
    const organizationId = process.env['SMOKE_ORGANIZATION_ID'] ?? login.body.data.user.organization_ids[0];

    if (!organizationId) throw new Error('the admin has no organization; set SMOKE_ORGANIZATION_ID');

    const tomorrow = dateIn(1);
    const [first, second, third] = [await client(), await client(), await client()];
    const book = (token: string, serviceId: string, body: Record<string, unknown>) =>
        call('POST', `/services/${serviceId}/bookings`, token, body);

    console.log(`== ${API}, organization ${organizationId}`);
    console.log('== service type and slot type matrix');
    check(
        'apply under service_delivery is refused',
        outcome(
            await call('POST', '/services', admin, {
                organization_id: organizationId,
                options: [{ service_type: 'service_delivery', slots: [{ child_type: 'apply', value: {} }] }],
            }),
        ),
        '422 SLOT_TYPE_NOT_ALLOWED',
    );
    check(
        'the legacy delivery slot type is refused',
        outcome(
            await call('POST', '/services', admin, {
                organization_id: organizationId,
                options: [
                    { service_type: 'service_delivery', slots: [{ child_type: 'delivery', value: {} }] },
                ],
            }),
        ),
        '400 VALIDATION_ERROR',
    );

    const created = await call('POST', '/services', admin, {
        organization_id: organizationId,
        status: 'published',
        label: `Smoke ${RUN}`,
        buffer_minutes: 0,
        value: { heading_value: `Smoke ${RUN}`, subscribe: 'operator@example.com' },
        options: [
            {
                label: 'Court',
                service_type: 'service_apply',
                slots: [
                    {
                        child_type: 'time_range',
                        value: {
                            date: tomorrow,
                            from: '08:00',
                            to: '14:00',
                            step_minutes: 30,
                            min_minutes: 60,
                        },
                    },
                    {
                        child_type: 'callback',
                        value: { date: tomorrow, time: [{ time: '10:00', to: '12:00', limit: 1 }] },
                    },
                    {
                        child_type: 'date_time',
                        value: { date: tomorrow, time: [{ time: '09:00', limit: 2 }] },
                    },
                ],
            },
            {
                label: 'Visit',
                service_type: 'service_visit',
                slots: [
                    {
                        child_type: 'time_range',
                        value: { date: tomorrow, from: '09:00', to: '17:00', step_minutes: 60 },
                    },
                ],
            },
            {
                label: 'Hand-over',
                service_type: 'service_delivery',
                slots: [
                    { child_type: 'pickup', value: { description: 'Office 1' } },
                    { child_type: 'courier', value: { price: '50' } },
                ],
            },
        ],
    });
    check('a service with every new slot type is created', created.status, 201);

    if (created.status !== 201) throw new Error(`create service: ${outcome(created)}`);

    const service = created.body.data;
    const serviceId = service.id;
    const apply = at(service.options, 0);
    const visit = at(service.options, 1);
    const delivery = at(service.options, 2);
    const range = at(apply.slots, 0);
    const callback = at(apply.slots, 1);
    const timed = at(apply.slots, 2);
    const courier = at(delivery.slots, 1);
    const onRange = (from: string, to: string) => ({
        option_id: apply.id,
        slot_id: range.id,
        time: from,
        end_time: to,
    });
    check(
        'default labels',
        service.options.flatMap((option: { slots: { label: string }[] }) =>
            option.slots.map((slot) => slot.label),
        ),
        ['Booking by interval', 'Call back', 'Booking', 'Booking by interval', 'Pickup', 'Courier delivery'],
    );

    console.log('== existing slot types keep working');
    check(
        'date_time booking',
        (await book(first, serviceId, { option_id: apply.id, slot_id: timed.id, time: '09:00' })).status,
        201,
    );
    check(
        'courier is information only',
        outcome(await book(first, serviceId, { option_id: delivery.id, slot_id: courier.id })),
        '422 SLOT_NOT_BOOKABLE',
    );

    console.log('== time_range');
    const booked = await book(first, serviceId, onRange('10:00', '11:00'));
    check('book 10:00-11:00', [booked.status, booked.body.data?.end_time], [201, '11:00']);
    check(
        'an overlap is refused',
        outcome(await book(second, serviceId, onRange('10:30', '11:30'))),
        '422 SLOT_FULL',
    );
    check(
        'an off-grid interval is refused',
        outcome(await book(second, serviceId, onRange('08:15', '09:15'))),
        '422 SLOT_RANGE_INVALID',
    );
    const availability = await call('GET', `/services/${serviceId}/availability`);
    check(
        'free intervals around the booking',
        at(availability.body.data.options, 0).slots.find((slot) => slot.id === range.id)?.range?.free,
        [
            { from: '08:00', to: '10:00' },
            { from: '11:00', to: '14:00' },
        ],
    );

    const racers = await Promise.all(Array.from({ length: 8 }, () => client()));
    const race = await Promise.all(racers.map((token) => book(token, serviceId, onRange('12:00', '13:00'))));
    check('eight concurrent overlapping requests let exactly one through', race.map(outcome).sort(), [
        '201',
        ...Array.from({ length: 7 }, () => '422 SLOT_FULL'),
    ]);

    const bookingId = booked.body.data.booking_id;
    const moved = await call('POST', `/bookings/${bookingId}/reschedule`, first, {
        slot_id: range.id,
        time: '08:00',
        end_time: '09:30',
    });
    check(
        'reschedule to 08:00-09:30',
        [moved.status, moved.body.data?.time, moved.body.data?.end_time],
        [200, '08:00', '09:30'],
    );
    const shifted = await call(
        'POST',
        `/services/${serviceId}/options/${apply.id}/slots/${range.id}/move`,
        admin,
        {
            date: tomorrow,
            shift_minutes: 30,
            notify: false,
        },
    );
    check('move the slot by 30 minutes', [shifted.status, shifted.body.data?.moved], [200, 2]);
    const after = await call('GET', `/bookings/${bookingId}`, first);
    check('the booking moved with it', [after.body.data.time, after.body.data.end_time], ['08:30', '10:00']);

    console.log('== callback');
    const window = { option_id: apply.id, slot_id: callback.id, time: '10:00' };
    const called = await book(second, serviceId, window);
    check('a call-back window is booked', [called.status, called.body.data?.end_time], [201, '12:00']);
    check('the window limit holds', outcome(await book(third, serviceId, window)), '422 SLOT_FULL');

    console.log('== service_visit');
    const home = { option_id: visit.id, slot_id: at(visit.slots, 0).id, time: '10:00', end_time: '11:00' };
    check(
        'an address is required',
        outcome(await book(third, serviceId, home)),
        '422 BOOKING_ADDRESS_REQUIRED',
    );
    const address = `Smoke street ${RUN}`;
    const visited = await book(third, serviceId, { ...home, address });
    check('a visit is booked', visited.status, 201);
    const visitId = visited.body.data.booking_id;
    check(
        'the owner sees the address',
        (await call('GET', `/bookings/${visitId}`, third)).body.data.address,
        address,
    );
    check(
        'the admin sees the address',
        (await call('GET', `/bookings/${visitId}`, admin)).body.data.address,
        address,
    );
    check('a stranger gets 404', (await call('GET', `/bookings/${visitId}`, first)).status, 404);
    check(
        'the public view hides the address',
        JSON.stringify((await call('GET', `/services/${serviceId}`)).body).includes(address),
        false,
    );
    check(
        'a client view hides the address',
        JSON.stringify((await call('GET', `/services/${serviceId}`, first)).body).includes(address),
        false,
    );

    console.log('== recurrent_ranges');
    check(
        'an interval schedule is accepted on the visit option',
        outcome(
            await call('PUT', `/services/${serviceId}/options/${visit.id}/recurrence`, admin, {
                recurrent_ranges: [
                    { day: 'monday', from: '09:00', to: '17:00', resources: ['Anna', 'Boris'] },
                ],
            }),
        ),
        '200',
    );
    check(
        'an interval schedule is refused on the delivery option',
        outcome(
            await call('PUT', `/services/${serviceId}/options/${delivery.id}/recurrence`, admin, {
                recurrent_ranges: [{ day: 'monday', from: '09:00', to: '17:00', resources: ['Van'] }],
            }),
        ),
        '422 SLOT_TYPE_NOT_ALLOWED',
    );

    console.log('== option type change');
    check(
        'a type that does not fit the slots is refused',
        outcome(
            await call('PATCH', `/services/${serviceId}/options/${apply.id}`, admin, {
                service_type: 'service_payment',
            }),
        ),
        '422 SLOT_TYPE_NOT_ALLOWED',
    );

    console.log(`== service ${serviceId}: passed ${passed}, failed ${failed}`);

    if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
