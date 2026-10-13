const KEPT_FOR_PHONE = { phone_hash: { $type: 'string' } };

const INDEXES = {
    bookings: [{ key: { phone_hash: 1 }, name: 'phone_hash_1', partialFilterExpression: KEPT_FOR_PHONE }],
    booking_suspensions: [
        {
            key: { phone_hash: 1, service_id: 1 },
            name: 'phone_hash_1_service_id_1',
            partialFilterExpression: KEPT_FOR_PHONE,
        },
        {
            key: { until: 1 },
            name: 'kept_for_phone_until_ttl',
            expireAfterSeconds: 0,
            partialFilterExpression: KEPT_FOR_PHONE,
        },
    ],
};

module.exports = {
    INDEXES,

    async up(db) {
        for (const [collection, indexes] of Object.entries(INDEXES)) {
            const existing = await db.listCollections({ name: collection }).toArray();

            if (existing.length === 0) await db.createCollection(collection);

            for (const { key, ...options } of indexes) {
                await db.collection(collection).createIndex(key, options);
            }
        }
    },

    async down(db) {
        for (const [collection, indexes] of Object.entries(INDEXES)) {
            const existing = await db.listCollections({ name: collection }).toArray();

            if (existing.length === 0) continue;

            const current = await db.collection(collection).indexes();

            for (const { name } of indexes) {
                if (current.some((index) => index.name === name))
                    await db.collection(collection).dropIndex(name);
            }
        }
    },
};
