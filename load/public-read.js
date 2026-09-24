import { discover, get, ok, pick, scenario } from './lib/common.js';

export const options = {
    scenarios: { publicRead: scenario('publicRead', 50) },
    thresholds: {
        http_req_failed: ['rate<0.01'],
        'http_req_duration{scenario:publicRead}': ['p(95)<300', 'p(99)<800'],
    },
};

export function setup() {
    return discover();
}

export function publicRead(ctx) {
    const serviceId = pick(ctx.serviceIds);

    switch (Math.floor(Math.random() * 7)) {
        case 0:
            return ok(get('/services', { limit: 30 }), 'services list');
        case 1:
            return ok(
                get('/services', { q: 'load', limit: 30 }, undefined, '/services?q'),
                'services search',
            );
        case 2:
            return ok(get(`/services/${serviceId}`, undefined, undefined, '/services/:id'), 'service');
        case 3:
            return ok(
                get(
                    '/services/nearby',
                    { lat: ctx.center.lat, lng: ctx.center.lng, radius_m: 3000, limit: 30 },
                    undefined,
                    '/services/nearby',
                ),
                'services nearby',
            );
        case 4:
            return ok(get(`/organizations/${ctx.orgId}`, undefined, undefined, '/organizations/:id'), 'org');
        case 5:
            return ok(
                get(
                    `/organizations/${ctx.orgId}/services`,
                    { limit: 30 },
                    undefined,
                    '/organizations/:id/services',
                ),
                'org services',
            );
        default:
            return ok(get('/news', { organization_id: ctx.orgId, limit: 30 }, undefined, '/news'), 'news');
    }
}

export default publicRead;
