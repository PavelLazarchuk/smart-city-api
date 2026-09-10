import { SetMetadata } from '@nestjs/common';

export const ROLES = {
    COMMON_USER: 'common-user',
    COMMON_ADMIN: 'common-admin',
    SUPER_ADMIN: 'super-admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
export const ROLE_VALUES = Object.values(ROLES) as [Role, ...Role[]];
export const ADMIN_ROLES: readonly Role[] = [ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN];

export const ROLES_KEY = 'smart_city:roles';

export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
