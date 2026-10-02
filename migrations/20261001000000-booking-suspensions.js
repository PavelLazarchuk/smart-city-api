const INDEXES = {
    booking_suspensions: [
        { key: { id: 1 }, name: 'id_1', unique: true },
        { key: { user_id: 1, service_id: 1 }, name: 'unique_suspension_per_service', unique: true },
        { key: { service_id: 1 }, name: 'service_id_1' },
        { key: { organization_id: 1, suspended_at: -1 }, name: 'organization_id_1_suspended_at_-1' },
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
