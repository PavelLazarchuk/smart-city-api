import { isPrivateHost, webhookUrlProblem } from './webhook-url';

describe('webhook url policy', () => {
    const strict = { allowPrivateHosts: false, requireHttps: true };
    const lax = { allowPrivateHosts: true, requireHttps: false };

    it('recognises loopback, link-local, private and reserved addresses', () => {
        for (const host of [
            'localhost',
            'api.localhost',
            '127.0.0.1',
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.1.1',
            '169.254.169.254',
            '100.64.0.1',
            '0.0.0.0',
            '::1',
            '[::1]',
            'fe80::1',
            'fd00::1',
            '::ffff:10.0.0.1',
        ]) {
            expect(isPrivateHost(host)).toBe(true);
        }

        for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) {
            expect(isPrivateHost(host)).toBe(false);
        }
    });

    it('refuses what an SSRF would need and accepts a public https target', () => {
        expect(webhookUrlProblem('not a url', strict)).toMatch(/absolute/);
        expect(webhookUrlProblem('ftp://example.com/hook', strict)).toMatch(/http/);
        expect(webhookUrlProblem('http://example.com/hook', strict)).toMatch(/https/);
        expect(webhookUrlProblem('https://user:pass@example.com/hook', strict)).toMatch(/credentials/);
        expect(webhookUrlProblem('https://169.254.169.254/latest/meta-data', strict)).toMatch(/private/);
        expect(webhookUrlProblem('https://example.com/hook', strict)).toBeNull();
        expect(webhookUrlProblem('http://127.0.0.1:9999/hook', lax)).toBeNull();
    });
});
