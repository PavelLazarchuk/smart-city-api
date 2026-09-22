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

    return isPrivateV4Octets(a, b);
}

function isPrivateV4Octets(a: number, b: number): boolean {
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

function groupsOfV6(address: string): number[] | null {
    let text = address;
    const lastColon = text.lastIndexOf(':') + 1;
    const tailPart = text.slice(lastColon);

    if (tailPart.includes('.')) {
        const octets = tailPart.split('.').map(Number);
        const [o1 = -1, o2 = -1, o3 = -1, o4 = -1] = octets;

        if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
            return null;

        const high = ((o1 << 8) | o2).toString(16);
        const low = ((o3 << 8) | o4).toString(16);
        text = `${text.slice(0, lastColon)}${high}:${low}`;
    }

    const halves = text.split('::');

    if (halves.length > 2) return null;

    const [headPart = '', tailHalf = ''] = halves;
    const head = headPart ? headPart.split(':') : [];
    const tail = halves.length === 2 && tailHalf ? tailHalf.split(':') : [];
    const gap = halves.length === 2 ? 8 - head.length - tail.length : 0;

    if (gap < 0) return null;

    const groups = [...head, ...Array<string>(gap).fill('0'), ...tail].map((part) =>
        /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN,
    );

    if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;

    return groups;
}

function isPrivateV6(address: string): boolean {
    const groups = groupsOfV6(address.toLowerCase());

    if (!groups) return true;

    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0] = groups;
    const embedsV4 = a === 0 && b === 0 && c === 0 && d === 0 && (e === 0 || (e === 0xffff && f === 0));

    if (embedsV4) return isPrivateV4Octets(g >>> 8, g & 0xff);

    if ((a & 0xfe00) === 0xfc00) return true;

    return (a & 0xffc0) === 0xfe80;
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
