import { type OrganizationStatus } from './schemas/organization.schema';

export interface Closable {
    status: OrganizationStatus;
    closed_until?: Date | null;
}

export function isClosedAt(organization: Closable, at: Date): boolean {
    if (organization.status !== 'temporarily_closed') return false;

    const until = organization.closed_until;

    return !until || at.getTime() < until.getTime();
}
