import { type JwtService } from '@nestjs/jwt';

import { type JwtKeySet } from './app-config';

export function secretFor(jwt: JwtService, token: string, keys: JwtKeySet): string | undefined {
    const decoded = jwt.decode<{ header?: { kid?: unknown } } | null>(token, { complete: true });
    const kid = decoded?.header?.kid;

    if (typeof kid !== 'string') return keys.secret;

    if (!Object.hasOwn(keys.accepted, kid)) return undefined;

    const secret = keys.accepted[kid];

    return typeof secret === 'string' ? secret : undefined;
}
