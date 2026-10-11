import { isPrivateHost, webhookUrlProblem } from './webhook-url';

describe('webhook url policy', () => {
    const strict = { allowPrivateHosts: false, requireHttps: true };
    const lax = { allowPrivateHosts: true, requireHttps: false };
    const httpAllowed = { allowPrivateHosts: false, requireHttps: false };

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

    it('sees through the hex form a URL serialises IPv4-mapped literals into', () => {
        for (const raw of [
            'http://[::ffff:169.254.169.254]/latest/meta-data',
            'http://[::ffff:127.0.0.1]:6379/',
            'http://[::ffff:10.0.0.1]/',
            'http://[::ffff:0:192.168.1.1]/',
            'http://[0:0:0:0:0:ffff:7f00:1]/',
            'http://[::127.0.0.1]/',
        ]) {
            expect(new URL(raw).hostname).not.toContain('.');
            expect(webhookUrlProblem(raw, httpAllowed)).toMatch(/private/);
        }

        expect(webhookUrlProblem('http://[2606:4700:4700::1111]/hook', httpAllowed)).toBeNull();
    });

    it('draws the private ranges exactly at their edges', () => {
        for (const host of [
            'printer.local',
            'LOCALHOST',
            '224.0.0.1',
            '255.255.255.255',
            '100.127.255.255',
            '::',
            'febf::1',
            'fc00::1',
            '::ffff:0.0.0.0',
        ]) {
            expect(isPrivateHost(host)).toBe(true);
        }

        for (const host of [
            '172.15.255.255',
            '192.169.0.1',
            '169.255.0.1',
            '100.63.255.255',
            '100.128.0.1',
            '223.255.255.255',
            'fec0::1',
            'fe00::1',
            '::ffff:8.8.8.8',
            '64:ff9b::1',
            'example.local.com',
        ]) {
            expect(isPrivateHost(host)).toBe(false);
        }
    });

    it('lets http through only when https is not required, and private hosts only when allowed', () => {
        expect(webhookUrlProblem('http://example.com/hook', httpAllowed)).toBeNull();
        expect(webhookUrlProblem('http://10.0.0.1/hook', httpAllowed)).toMatch(/private/);
        expect(webhookUrlProblem('https://user@example.com/hook', lax)).toMatch(/credentials/);
        expect(webhookUrlProblem('https://:secret@example.com/hook', lax)).toMatch(/credentials/);
        expect(webhookUrlProblem('javascript:alert(1)', lax)).toMatch(/http/);
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
