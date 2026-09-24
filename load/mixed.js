import { discover, scenario } from './lib/common.js';
import { availability } from './availability.js';
import { bookings, bookingsSetup } from './bookings.js';
import { publicRead } from './public-read.js';

const USERS = Number(__ENV.LOAD_USERS || 200);

export { availability, bookings, publicRead };

export const options = {
    scenarios: {
        publicRead: scenario('publicRead', 40),
        availability: scenario('availability', 8),
        bookings: scenario('bookings', 2, USERS),
    },
    setupTimeout: '5m',
    thresholds: {
        http_req_failed: ['rate<0.01'],
        'http_req_duration{scenario:publicRead}': ['p(95)<300'],
        'http_req_duration{scenario:availability}': ['p(95)<500'],
        'http_req_duration{scenario:bookings}': ['p(95)<800'],
    },
};

export function setup() {
    return bookingsSetup(discover());
}
