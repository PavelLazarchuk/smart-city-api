import { LOAD_PASSWORD, login, phoneOf, scenario } from './lib/common.js';

const USERS = Number(__ENV.LOAD_USERS || 200);

export const options = {
    scenarios: { auth: scenario('auth', 5, 100) },
    thresholds: {
        http_req_failed: ['rate<0.01'],
        'http_req_duration{name:/auth/login}': ['p(95)<1000'],
    },
};

export function auth() {
    login({ phone: phoneOf(Math.floor(Math.random() * USERS)), password: LOAD_PASSWORD });
}

export default auth;
