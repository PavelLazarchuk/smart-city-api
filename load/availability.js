import { discover, get, ok, scenario } from './lib/common.js';

export const options = {
    scenarios: { availability: scenario('availability', 20) },
    thresholds: {
        http_req_failed: ['rate<0.01'],
        'http_req_duration{scenario:availability}': ['p(95)<500', 'p(99)<1200'],
    },
};

export function setup() {
    return discover();
}

export function availability(ctx) {
    if (Math.random() < 0.5)
        return ok(
            get(
                `/services/${ctx.bookableId}/availability`,
                undefined,
                undefined,
                '/services/:id/availability',
            ),
            'availability',
        );

    return ok(
        get(
            `/services/${ctx.bookableId}/slots`,
            { only_available: true, limit: 50 },
            undefined,
            '/services/:id/slots',
        ),
        'slots',
    );
}

export default availability;
