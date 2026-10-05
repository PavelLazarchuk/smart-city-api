import { Types } from 'mongoose';
import { z } from 'zod';

import { sanitizeRichText } from '../html';
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

export const LABEL_MAX_LENGTH = 200;

export const labelSchema = z.string().trim().min(1).max(LABEL_MAX_LENGTH);

export const enabledSchema = z.boolean();

export const fieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Must be snake_case');

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

export const urlSchema = z.url({ protocol: /^https?$/ }).max(2048);

export const linkUrlSchema = z.url({ protocol: /^(https?|mailto|tel|viber|tg)$/ }).max(2048);

const isSafeLink = (value: string): boolean => {
    if (value === '') return true;

    if (/[\\\s\p{Cc}]/u.test(value)) return false;

    if (value.startsWith('/')) return !value.startsWith('//');

    if (!/^https?:\/\//i.test(value)) return false;

    try {
        return new URL(value).hostname !== '';
    } catch {
        return false;
    }
};

export const safeLinkSchema = z
    .string()
    .trim()
    .max(5000)
    .refine(isSafeLink, 'Must be an http(s) URL or a relative path');

export const richTextSchema = (max: number) =>
    z.string().trim().max(max).transform(sanitizeRichText).pipe(z.string().max(max));

export const plainTextSchema = (max: number, multiline = true) =>
    z
        .string()
        .transform((value) => {
            const text = value.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]/gu, '');

            return (multiline ? text : text.replace(/\s+/g, ' ')).trim();
        })
        .pipe(z.string().min(1).max(max));
