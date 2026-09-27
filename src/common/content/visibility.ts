import { Types } from 'mongoose';

import { type AuthUser } from '../decorators/current-user.decorator';
import { ROLES } from '../decorators/roles.decorator';

export function administers(viewer: AuthUser | undefined, organizationId: string): boolean {
    if (!viewer) return false;

    if (viewer.role === ROLES.SUPER_ADMIN) return true;

    return viewer.role === ROLES.COMMON_ADMIN && viewer.organization_ids.includes(organizationId);
}

export function releasedClause(viewer: AuthUser | undefined, now: Date): Record<string, unknown> | undefined {
    if (viewer?.role === ROLES.SUPER_ADMIN) return undefined;

    const own = viewer?.role === ROLES.COMMON_ADMIN ? viewer.organization_ids : [];
    const released: Record<string, unknown>[] = [{ publish_at: null }, { publish_at: { $lte: now } }];

    if (own.length === 0) return { $or: released };

    return { $or: [...released, { organization_id: { $in: own.map((id) => new Types.ObjectId(id)) } }] };
}

export function publishedClause(viewer?: AuthUser): Record<string, unknown> | undefined {
    if (viewer?.role === ROLES.SUPER_ADMIN) return undefined;

    const own = viewer?.role === ROLES.COMMON_ADMIN ? viewer.organization_ids : [];

    if (own.length === 0) return { enabled: true };

    return {
        $or: [{ enabled: true }, { organization_id: { $in: own.map((id) => new Types.ObjectId(id)) } }],
    };
}
