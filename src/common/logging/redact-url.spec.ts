import { redactUrl } from './redact-url';

describe('redactUrl', () => {
    it('hides a token wherever it sits in the query', () => {
        expect(redactUrl('/api/v1/me/bookings.ics?token=abc-123')).toBe(
            '/api/v1/me/bookings.ics?token=[redacted]',
        );
        expect(redactUrl('/x?a=1&token=secret&b=2#top')).toBe('/x?a=1&token=[redacted]&b=2#top');
        expect(redactUrl('/x?TOKEN=secret')).toBe('/x?TOKEN=[redacted]');
        expect(redactUrl('token=secret&a=1')).toBe('token=[redacted]&a=1');
    });

    it('hides a token whose key is percent-encoded, as Express would still read it', () => {
        expect(redactUrl('/api/v1/me/bookings.ics?tok%65n=secret')).toBe(
            '/api/v1/me/bookings.ics?tok%65n=[redacted]',
        );
        expect(redactUrl('/x?%74%6F%6B%65%6E=secret&a=1')).toBe('/x?%74%6F%6B%65%6E=[redacted]&a=1');
        expect(redactUrl('?tok%65n=secret')).toBe('?tok%65n=[redacted]');
        expect(redactUrl('/x?%E0%A4%A=1&token=secret')).toBe('/x?%E0%A4%A=1&token=[redacted]');
    });

    it('leaves other parameters and missing urls alone', () => {
        expect(redactUrl('/x?my_token=1&tokens=2')).toBe('/x?my_token=1&tokens=2');
        expect(redactUrl(undefined)).toBe('');
        expect(redactUrl('/api/v1/organizations')).toBe('/api/v1/organizations');
        expect(redactUrl('/x?token')).toBe('/x?token');
    });
});
