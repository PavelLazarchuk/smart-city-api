import { type AuthUser } from '../decorators/current-user.decorator';

export const AUTH_USER_RESOLVER = Symbol('AUTH_USER_RESOLVER');

/** Implemented by the users module: loads the current principal for a verified access token. */
export interface AuthUserResolver {
    resolve(userId: string, sid: string): Promise<AuthUser | null>;
}
