import { Types } from 'mongoose';

import { type AuthUser } from '../decorators/current-user.decorator';
import { ROLES } from '../decorators/roles.decorator';

export function administers(viewer: AuthUser | undefined, organizationId: string): boolean {
    if (!viewer) return false;

    if (viewer.role === ROLES.SUPER_ADMIN) return true;

    return viewer.role === ROLES.COMMON_ADMIN && viewer.organization_ids.includes(organizationId);
}

export function publishedClause(viewer?: AuthUser): Record<string, unknown> | undefined {
    if (viewer?.role === ROLES.SUPER_ADMIN) return undefined;

    const own = viewer?.role === ROLES.COMMON_ADMIN ? viewer.organization_ids : [];

    if (own.length === 0) return { enabled: true };

    return {
        $or: [{ enabled: true }, { organization_id: { $in: own.map((id) => new Types.ObjectId(id)) } }],
    };
}
