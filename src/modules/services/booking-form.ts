import { type ApiErrorDetail } from '../../common/http/api-error';
import { type FormField, type RequiredDocument } from './schemas/service.schema';

const PHONE = /^\d{8,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateBookingFields(
    fields: FormField[],
    answers: Record<string, unknown>,
): { details: ApiErrorDetail[]; values: Record<string, unknown> } {
    const details: ApiErrorDetail[] = [];
    const declared = new Map(fields.map((field) => [field.key, field]));
    const values: Record<string, unknown> = {};

    for (const key of Object.keys(answers)) {
        if (!declared.has(key)) details.push({ path: `fields.${key}`, message: 'Unknown field' });
    }

    for (const field of fields) {
        const path = `fields.${field.key}`;
        const value = answers[field.key];
        const missing = value === undefined || value === null || value === '';

        if (missing) {
            if (field.required) details.push({ path, message: 'Required' });

            continue;
        }

        const problem = problemOf(field, value);

        if (problem) {
            details.push({ path, message: problem });
            continue;
        }

        values[field.key] = value;
    }

    return { details, values };
}

function problemOf(field: FormField, value: unknown): string | null {
    const max = field.max_length ?? 1000;

    switch (field.type) {
        case 'text':
        case 'textarea':
            if (typeof value !== 'string') return 'Must be a string';

            return value.length > max ? `Must be at most ${max} characters` : null;
        case 'phone':
            return typeof value === 'string' && PHONE.test(value) ? null : 'Must be a phone number';
        case 'email':
            return typeof value === 'string' && EMAIL.test(value) && value.length <= 254
                ? null
                : 'Must be an e-mail address';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value) ? null : 'Must be a number';
        case 'boolean':
            return typeof value === 'boolean' ? null : 'Must be true or false';
        case 'date':
            return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
                ? null
                : 'Must be a date (YYYY-MM-DD)';
        case 'select':
            return typeof value === 'string' && (field.options ?? []).includes(value)
                ? null
                : 'Must be one of the options';
        default:
            return 'Unsupported field type';
    }
}

export function validateDocuments(required: RequiredDocument[], confirmed: string[]): ApiErrorDetail[] {
    const details: ApiErrorDetail[] = [];
    const known = new Set(required.map((document) => document.key));

    for (const key of confirmed) {
        if (!known.has(key)) details.push({ path: `documents.${key}`, message: 'Unknown document' });
    }

    for (const document of required) {
        if (document.required && !confirmed.includes(document.key))
            details.push({ path: `documents.${document.key}`, message: `Confirm "${document.label}"` });
    }

    return details;
}
