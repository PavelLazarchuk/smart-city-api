const INDEXES = {
    images: [{ key: { name: 1 }, name: 'name_1' }],
};

module.exports = {
    INDEXES,

    /** Without it every `storage_gc` batch is a collection scan of `images`. */
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
