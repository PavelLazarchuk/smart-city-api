const NOTIFICATION_RETENTION_DAYS = 30;

const INDEXES = {
    notifications: [
        { key: { id: 1 }, name: 'id_1', unique: true },
        {
            key: { user_id: 1, status: 1, created_at: -1, _id: -1 },
            name: 'user_id_1_status_1_created_at_-1__id_-1',
        },
        {
            key: { organization_id: 1, audience: 1, status: 1, created_at: -1, _id: -1 },
            name: 'organization_id_1_audience_1_status_1_created_at_-1__id_-1',
        },
        {
            key: { source_event_id: 1, audience: 1 },
            name: 'unique_notification_per_event',
            unique: true,
            partialFilterExpression: { source_event_id: { $type: 'string' } },
        },
        {
            key: { subject_user_id: 1 },
            name: 'subject_user_id_1',
            partialFilterExpression: { audience: 'staff' },
        },
        {
            key: { created_at: 1 },
            name: 'created_at_1',
            expireAfterSeconds: NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60,
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
