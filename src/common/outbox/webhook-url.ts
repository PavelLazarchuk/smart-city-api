import { isIP } from 'node:net';

export function isPrivateHost(host: string): boolean {
    const bare = host.replace(/^\[|\]$/g, '').toLowerCase();

    if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) return true;

    const family = isIP(bare);

    if (family === 4) return isPrivateV4(bare);

    if (family === 6) return isPrivateV6(bare);

    return false;
}

function isPrivateV4(address: string): boolean {
    const [a = 0, b = 0] = address.split('.').map(Number);

    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224
    );
}

function isPrivateV6(address: string): boolean {
    const lower = address.toLowerCase();

    if (lower === '::' || lower === '::1') return true;

    if (lower.startsWith('::ffff:')) return isPrivateV4(lower.slice('::ffff:'.length));

    return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

export interface UrlPolicy {
    allowPrivateHosts: boolean;
    requireHttps: boolean;
}

export function webhookUrlProblem(raw: string, policy: UrlPolicy): string | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return 'Must be an absolute URL';
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Must use http or https';

    if (policy.requireHttps && url.protocol !== 'https:') return 'Must use https';

    if (url.username || url.password) return 'Must not carry credentials';

    if (!policy.allowPrivateHosts && isPrivateHost(url.hostname))
        return 'Must not point at a loopback, link-local or private address';

    return null;
}
