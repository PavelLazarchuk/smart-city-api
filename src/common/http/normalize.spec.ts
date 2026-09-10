import { Types } from 'mongoose';

import { normalize } from './normalize';

describe('normalize', () => {
    it('maps _id to id, ObjectId and Date to strings, drops __v, recursively', () => {
        const id = new Types.ObjectId();
        const nested = new Types.ObjectId();
        const date = new Date('2026-01-01T00:00:00.000Z');
        expect(
            normalize({
                _id: id,
                __v: 0,
                created_at: date,
                items: [{ _id: nested, ref: nested }],
                keep: null,
            }),
        ).toEqual({
            id: id.toHexString(),
            created_at: '2026-01-01T00:00:00.000Z',
            items: [{ id: nested.toHexString(), ref: nested.toHexString() }],
            keep: null,
        });
    });
});
