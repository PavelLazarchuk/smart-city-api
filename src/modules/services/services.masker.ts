import { Injectable } from '@nestjs/common';

import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { ROLES } from '../../common/decorators/roles.decorator';
import { texts } from '../../common/i18n/messages';

export interface ServiceView {
    _id: unknown;
    organization_id: unknown;
    category_id?: unknown;
    value?: { subscribe?: string };
    options?: {
        slots?: {
            value?: {
                booked_count?: number;
                bookings?: unknown[];
                time?: { booked_count?: number; bookings?: unknown[] }[];
            };
        }[];
    }[];
}

/**
 * Role-aware masking: the owning organization's admins and super-admins see bookings and `subscribe`;
 * everyone else sees `{ status: 'reserved' }` slots and no `subscribe`.
 */
@Injectable()
export class ServicesMasker {
    canSeeDetails(viewer: AuthUser | undefined, organizationId: string): boolean {
        if (!viewer) return false;

        if (viewer.role === ROLES.SUPER_ADMIN) return true;

        return viewer.role === ROLES.COMMON_ADMIN && viewer.organization_ids.includes(organizationId);
    }

    /**
     * Tree variant: `findTree` leaves the booking documents in the database, so markers are rebuilt from
     * `booked_count` — occupancy without PII, at a size independent of the number of bookings.
     */
    maskCounts<T extends ServiceView>(service: T): T {
        const marker = { status: texts.bookings.reservedStatus };
        const markers = (count?: number): unknown[] =>
            Array.from({ length: Math.max(0, count ?? 0) }, () => marker);
        const { subscribe: _subscribe, ...value } = service.value ?? {};

        return {
            ...service,
            value,
            options: (service.options ?? []).map((option) => ({
                ...option,
                slots: (option.slots ?? []).map((slot) => ({
                    ...slot,
                    value: slot.value
                        ? {
                              ...slot.value,
                              ...(slot.value.time
                                  ? {
                                        time: slot.value.time.map((entry) => ({
                                            ...entry,
                                            bookings: markers(entry.booked_count),
                                        })),
                                    }
                                  : { bookings: markers(slot.value.booked_count) }),
                          }
                        : slot.value,
                })),
            })),
        };
    }

    mask<T extends ServiceView>(service: T, viewer: AuthUser | undefined, organizationId?: string): T {
        const orgId = organizationId ?? String(service.organization_id);

        if (this.canSeeDetails(viewer, orgId)) return service;

        const masked = { status: texts.bookings.reservedStatus };
        const { subscribe: _subscribe, ...value } = service.value ?? {};
        const result = {
            ...service,
            value,
            options: (service.options ?? []).map((option) => ({
                ...option,
                slots: (option.slots ?? []).map((slot) => ({
                    ...slot,
                    value: slot.value
                        ? {
                              ...slot.value,
                              ...(slot.value.bookings
                                  ? { bookings: slot.value.bookings.map(() => masked) }
                                  : {}),
                              ...(slot.value.time
                                  ? {
                                        time: slot.value.time.map((entry) => ({
                                            ...entry,
                                            bookings: (entry.bookings ?? []).map(() => masked),
                                        })),
                                    }
                                  : {}),
                          }
                        : slot.value,
                })),
            })),
        };

        return result;
    }
}
