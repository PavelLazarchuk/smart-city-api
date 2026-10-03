import { validateBookingFields, validateDocuments } from './booking-form';
import { type FormField } from './schemas/service.schema';

function field(overrides: Partial<FormField> & Pick<FormField, 'key' | 'type'>): FormField {
    return { label: overrides.key, required: false, max_length: null, ...overrides };
}

describe('validateBookingFields', () => {
    it('accepts valid answers of every type and returns them as values', () => {
        const fields = [
            field({ key: 'name', type: 'text' }),
            field({ key: 'note', type: 'textarea' }),
            field({ key: 'phone', type: 'phone' }),
            field({ key: 'email', type: 'email' }),
            field({ key: 'age', type: 'number' }),
            field({ key: 'agree', type: 'boolean' }),
            field({ key: 'birthday', type: 'date' }),
            field({ key: 'kind', type: 'select', options: ['a', 'b'] }),
        ];
        const answers = {
            name: 'Anna',
            note: 'hello',
            phone: '4915291234567',
            email: 'a@b.co',
            age: 0,
            agree: false,
            birthday: '2026-10-03',
            kind: 'b',
        };

        expect(validateBookingFields(fields, answers)).toEqual({ details: [], values: answers });
    });

    it('reports unknown fields and required fields that are missing, null or empty', () => {
        const fields = [field({ key: 'a', type: 'text', required: true }), field({ key: 'b', type: 'text' })];

        const { details, values } = validateBookingFields(fields, { a: '', b: null, c: 1 });

        expect(details).toEqual(
            expect.arrayContaining([
                { path: 'fields.c', message: 'Unknown field' },
                { path: 'fields.a', message: 'Required' },
            ]),
        );
        expect(details).toHaveLength(2);
        expect(values).toEqual({});
    });

    it('skips a missing optional field', () => {
        expect(validateBookingFields([field({ key: 'a', type: 'text' })], {})).toEqual({
            details: [],
            values: {},
        });
    });

    it.each([
        ['text', 1, 'Must be a string'],
        ['textarea', {}, 'Must be a string'],
        ['phone', '12345', 'Must be a phone number'],
        ['phone', 4915291234567, 'Must be a phone number'],
        ['email', 'nope', 'Must be an e-mail address'],
        ['email', `${'a'.repeat(250)}@b.co`, 'Must be an e-mail address'],
        ['number', '5', 'Must be a number'],
        ['number', Number.NaN, 'Must be a number'],
        ['boolean', 'true', 'Must be true or false'],
        ['date', '03.10.2026', 'Must be a date (YYYY-MM-DD)'],
        ['date', '2026-13-45', 'Must be a date (YYYY-MM-DD)'],
        ['select', 'c', 'Must be one of the options'],
    ] as const)('rejects a %s answer of %j', (type, value, message) => {
        const { details, values } = validateBookingFields([field({ key: 'x', type, options: ['a'] })], {
            x: value,
        });

        expect(details).toEqual([{ path: 'fields.x', message }]);
        expect(values).toEqual({});
    });

    it('limits text to max_length, defaulting to 1000', () => {
        const limited = [field({ key: 'x', type: 'text', max_length: 3 })];

        expect(validateBookingFields(limited, { x: 'abc' }).details).toEqual([]);
        expect(validateBookingFields(limited, { x: 'abcd' }).details).toEqual([
            { path: 'fields.x', message: 'Must be at most 3 characters' },
        ]);

        const unlimited = [field({ key: 'x', type: 'textarea' })];

        expect(validateBookingFields(unlimited, { x: 'a'.repeat(1000) }).details).toEqual([]);
        expect(validateBookingFields(unlimited, { x: 'a'.repeat(1001) }).details).toHaveLength(1);
    });

    it('rejects a select without options and an unsupported type', () => {
        expect(validateBookingFields([field({ key: 'x', type: 'select' })], { x: 'a' }).details).toHaveLength(
            1,
        );
        expect(
            validateBookingFields([field({ key: 'x', type: 'weird' as FormField['type'] })], { x: 'a' })
                .details,
        ).toEqual([{ path: 'fields.x', message: 'Unsupported field type' }]);
    });
});

describe('validateDocuments', () => {
    const required = [
        { key: 'passport', label: 'Passport', required: true },
        { key: 'photo', label: 'Photo', required: false },
    ];

    it('passes when every required document is confirmed', () => {
        expect(validateDocuments(required, ['passport'])).toEqual([]);
        expect(validateDocuments(required, ['passport', 'photo'])).toEqual([]);
    });

    it('asks to confirm a missing required document and rejects unknown ones', () => {
        expect(validateDocuments(required, ['id'])).toEqual([
            { path: 'documents.id', message: 'Unknown document' },
            { path: 'documents.passport', message: 'Confirm "Passport"' },
        ]);
    });

    it('passes without any documents declared', () => {
        expect(validateDocuments([], [])).toEqual([]);
    });
});
