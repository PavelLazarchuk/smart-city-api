import { JwtService } from '@nestjs/jwt';

import { type JwtKeySet } from './app-config';
import { secretFor } from './jwt-keys';

describe('secretFor', () => {
    const jwt = new JwtService();
    const keys: JwtKeySet = {
        kid: 'access-1',
        secret: 'secret-one',
        accepted: { 'access-1': 'secret-one', 'access-0': 'secret-zero' },
    };
    const tokenWith = (header: Record<string, unknown>) =>
        `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;

    it('returns the secret registered under the kid', () => {
        expect(secretFor(jwt, tokenWith({ kid: 'access-1' }), keys)).toBe('secret-one');
        expect(secretFor(jwt, tokenWith({ kid: 'access-0' }), keys)).toBe('secret-zero');
    });

    it('falls back to the current secret when the header carries no kid', () => {
        expect(secretFor(jwt, tokenWith({}), keys)).toBe('secret-one');
        expect(secretFor(jwt, tokenWith({ kid: 42 }), keys)).toBe('secret-one');
    });

    it('never hands back anything inherited from Object.prototype', () => {
        for (const kid of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'nope']) {
            expect(secretFor(jwt, tokenWith({ kid }), keys)).toBeUndefined();
        }
    });
});
