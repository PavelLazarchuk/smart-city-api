import { SetMetadata } from '@nestjs/common';

export const TRACK_EVENT_KEY = 'smart_city:track_event';

export const EVENT_TYPES = {
    ORGANIZATIONS_LISTED: 'organizations.listed',
    ORGANIZATION_VIEWED: 'organization.viewed',
    OTP_REQUESTED: 'auth.otp_requested',
    OTP_VERIFIED: 'auth.otp_verified',
    BOOKING_CREATED: 'booking.created',
    BOOKING_CANCELLED: 'booking.cancelled',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
export const EVENT_TYPE_VALUES = Object.values(EVENT_TYPES) as [EventType, ...EventType[]];

export interface TrackEventOptions {
    type: EventType;
    extract?: (result: unknown, body: unknown) => Record<string, unknown>;
}

export const TrackEvent = (type: EventType, extract?: TrackEventOptions['extract']): MethodDecorator =>
    SetMetadata<string, TrackEventOptions>(TRACK_EVENT_KEY, { type, extract });
