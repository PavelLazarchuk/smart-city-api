import { Types } from 'mongoose';

/**
 * Converts a lean Mongoose document into plain JSON values — `_id` → `id`, `ObjectId` → string,
 * `Date` → ISO string, `__v` dropped — so response schemas describe only the wire format.
 */
export function normalize(value: unknown): unknown {
    if (value === null || value === undefined) return value;

    if (value instanceof Types.ObjectId) return value.toHexString();

    if (value instanceof Date) return value.toISOString();

    if (Buffer.isBuffer(value)) return value.toString('base64');

    if (Array.isArray(value)) return value.map(normalize);

    if (typeof value === 'object') {
        const source = value as Record<string, unknown>;

        if (typeof (source as { toObject?: unknown }).toObject === 'function') {
            return normalize((source as { toObject: () => unknown }).toObject());
        }

        const result: Record<string, unknown> = {};

        for (const [key, item] of Object.entries(source)) {
            if (key === '__v') continue;

            if (key === '_id') {
                result['id'] = normalize(item);
                continue;
            }

            result[key] = normalize(item);
        }

        return result;
    }

    return value;
}
