const INDEXES = {
    idempotency_keys: [
        { key: { scope: 1, user_id: 1, key: 1 }, name: 'unique_idempotency_key', unique: true },
        { key: { expires_at: 1 }, name: 'expires_at_1', expireAfterSeconds: 0 },
    ],
    bookings: [{ key: { organization_id: 1, slot_date: 1 }, name: 'organization_id_1_slot_date_1' }],
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
