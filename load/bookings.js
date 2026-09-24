import { check } from 'k6';

import {
    LOAD_PASSWORD,
    del,
    discover,
    login,
    phoneOf,
    pick,
    post,
    scenario,
    slotCandidates,
} from './lib/common.js';

const USERS = Number(__ENV.LOAD_USERS || 200);

export const options = {
    scenarios: { bookings: scenario('bookings', 5, USERS) },
    setupTimeout: '5m',
    thresholds: {
        http_req_failed: ['rate<0.02'],
        'http_req_duration{name:POST /services/:id/bookings}': ['p(95)<800', 'p(99)<2000'],
        'http_req_duration{name:DELETE /services/:id/bookings/:booking_id}': ['p(95)<800'],
    },
};

export function bookingsSetup(ctx) {
    const tokens = [];

    for (let i = 0; i < USERS; i++) tokens.push(login({ phone: phoneOf(i), password: LOAD_PASSWORD }));

    return Object.assign({}, ctx, { tokens, candidates: slotCandidates(ctx.bookableId) });
}

export function setup() {
    return bookingsSetup(discover());
}

export function bookings(ctx) {
    const token = ctx.tokens[(__VU - 1) % ctx.tokens.length];
    const target = pick(ctx.candidates);
    const created = post(
        `/services/${ctx.bookableId}/bookings`,
        target,
        token,
        'POST /services/:id/bookings',
        { 'Idempotency-Key': `load-${__VU}-${__ITER}-${Date.now()}` },
    );
    const booked = check(created, { 'booking 201': (r) => r.status === 201 });

    if (!booked) return;

    const cancelled = del(
        `/services/${ctx.bookableId}/bookings/${created.json('data.booking_id')}`,
        token,
        'DELETE /services/:id/bookings/:booking_id',
    );
    check(cancelled, { 'cancel 204': (r) => r.status === 204 });
}

export default bookings;
