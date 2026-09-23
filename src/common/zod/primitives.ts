import { Types } from 'mongoose';
import { z } from 'zod';

import { isSupportedTimeZone } from '../time/zone';

export const objectIdSchema = z
    .string()
    .regex(/^[a-f0-9]{24}$/i, 'Must be a valid object id')
    .refine((value) => Types.ObjectId.isValid(value), 'Must be a valid object id');

export const phoneSchema = z
    .string()
    .regex(/^\d{8,15}$/, 'Must be a phone number in E.164 digits without the plus sign');

export const passwordSchema = z.string().min(1).max(128);

export const loginSchema = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._@-]+$/, 'Login may contain letters, digits, dots, underscores, @ and dashes');

export const nameSchema = z.string().trim().min(1).max(120);

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const labelSchema = z.string().trim().min(1).max(200);

export const enabledSchema = z.boolean();

export const dateOnlySchema = z.iso.date();

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm');

export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const timeZoneSchema = z
    .string()
    .trim()
    .max(64)
    .refine(isSupportedTimeZone, 'Must be an IANA time zone name');

export const uuidSchema = z.uuid();

export const idListSchema = z.array(objectIdSchema).min(1).max(500);

export const idOutputSchema = z.string();

export const timestampsOutputSchema = {
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
};

export const positionSchema = z.number().int().min(0);

export const urlSchema = z.url().max(2048);
