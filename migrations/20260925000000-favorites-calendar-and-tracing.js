const INDEXES = {
    favorites: [
        { key: { user_id: 1, type: 1, target_id: 1 }, name: 'unique_favorite', unique: true },
        { key: { user_id: 1, created_at: -1 }, name: 'user_id_1_created_at_-1' },
        { key: { target_id: 1 }, name: 'target_id_1' },
        { key: { organization_id: 1 }, name: 'organization_id_1' },
    ],
    users: [
        {
            key: { calendar_token_hash: 1 },
            name: 'calendar_token_hash_1',
            unique: true,
            partialFilterExpression: { calendar_token_hash: { $type: 'string' } },
        },
    ],
    bookings: [{ key: { user_id: 1, starts_at: 1 }, name: 'user_id_1_starts_at_1' }],
    news: [{ key: { organization_id: 1, publish_at: -1 }, name: 'organization_id_1_publish_at_-1' }],
    outbox_events: [
        {
            key: { request_id: 1 },
            name: 'request_id_1',
            partialFilterExpression: { request_id: { $type: 'string' } },
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
