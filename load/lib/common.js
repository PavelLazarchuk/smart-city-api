import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080/api/v1').replace(/\/+$/, '');
export const PROFILE = __ENV.PROFILE || 'smoke';
export const LOAD_ORG_LABEL = 'Load Test Org';
export const LOAD_BOOKABLE_LABEL = 'Load bookable service';
export const LOAD_PASSWORD = 'Load-Test-Pass1';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function stagesFor(profile, rate) {
    switch (profile) {
        case 'smoke':
            return [{ target: 1, duration: '30s' }];
        case 'load':
            return [
                { target: rate, duration: '1m' },
                { target: rate, duration: __ENV.DURATION || '5m' },
                { target: 0, duration: '30s' },
            ];
        case 'stress':
            return [1, 2, 3, 4, 5].flatMap((step) => [
                { target: rate * step, duration: '30s' },
                { target: rate * step, duration: '2m' },
            ]);
        case 'spike':
            return [
                { target: rate, duration: '1m' },
                { target: rate * 10, duration: '10s' },
                { target: rate * 10, duration: '1m' },
                { target: rate, duration: '10s' },
                { target: rate, duration: '2m' },
            ];
        case 'soak':
            return [
                { target: rate, duration: '5m' },
                { target: rate, duration: __ENV.DURATION || '1h' },
                { target: 0, duration: '1m' },
            ];
        default:
            throw new Error(`Unknown PROFILE "${profile}": smoke | load | stress | spike | soak`);
    }
}

export function scenario(exec, defaultRate, maxVUs = 500) {
    const rate = Number(__ENV[`RATE_${exec.toUpperCase()}`] || __ENV.RATE || defaultRate);

    return {
        executor: 'ramping-arrival-rate',
        exec,
        startRate: PROFILE === 'smoke' ? 1 : Math.max(1, Math.floor(rate / 10)),
        timeUnit: '1s',
        preAllocatedVUs: PROFILE === 'smoke' ? 2 : Math.min(maxVUs, Math.max(10, rate * 2)),
        maxVUs: PROFILE === 'smoke' ? 5 : maxVUs,
        stages: stagesFor(PROFILE, rate),
    };
}

export function url(path, query) {
    const params = Object.entries(query || {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');

    return `${BASE_URL}${path}${params ? `?${params}` : ''}`;
}

export function get(path, query, token, name) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    return http.get(url(path, query), { headers, tags: { name: name || path } });
}

export function post(path, body, token, name, extraHeaders) {
    const headers = Object.assign({}, JSON_HEADERS, extraHeaders || {});

    if (token) headers.Authorization = `Bearer ${token}`;

    return http.post(url(path), JSON.stringify(body), { headers, tags: { name: name || path } });
}

export function del(path, token, name) {
    return http.del(url(path), null, {
        headers: { Authorization: `Bearer ${token}` },
        tags: { name: name || path },
    });
}

export function ok(res, label) {
    return check(res, { [`${label} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
}

export function login(body) {
    const res = post('/auth/login', body, undefined, '/auth/login');

    if (res.status !== 200) fail(`login failed with ${res.status}: ${res.body}`);

    return res.json('data.access_token');
}

export function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
}

export function phoneOf(index) {
    return `49170${String(index).padStart(7, '0')}`;
}

export function discover() {
    const orgs = get('/organizations', { q: LOAD_ORG_LABEL, limit: 100 });

    if (orgs.status !== 200) fail(`GET /organizations answered ${orgs.status}: ${orgs.body}`);

    const org = (orgs.json('data') || []).find((item) => item.main_label === LOAD_ORG_LABEL);

    if (!org) fail(`"${LOAD_ORG_LABEL}" not found: run \`npm run seed:load\` against this stand first`);

    const list = get('/services', { organization_id: org.id, limit: 100 });
    const services = list.json('data') || [];
    const bookable = services.find((item) => item.label === LOAD_BOOKABLE_LABEL);

    if (!bookable) fail(`"${LOAD_BOOKABLE_LABEL}" not found: re-seed the stand`);

    return {
        orgId: org.id,
        bookableId: bookable.id,
        serviceIds: services.map((item) => item.id),
        center: { lat: 52.52, lng: 13.405 },
    };
}

export function slotCandidates(serviceId) {
    const res = get(`/services/${serviceId}/slots`, { only_available: true, limit: 200 });

    if (res.status !== 200) fail(`GET /services/:id/slots answered ${res.status}: ${res.body}`);

    const items = (res.json('data.items') || []).filter((item) => item.time);

    if (items.length === 0)
        fail('The bookable service has no future slots left: reset the load DB and re-seed');

    return items.map((item) => ({ option_id: item.option_id, slot_id: item.slot_id, time: item.time }));
}
