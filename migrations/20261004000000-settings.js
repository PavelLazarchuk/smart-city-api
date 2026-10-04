const { ObjectId } = require('mongodb');

const SETTINGS_DOCUMENT_ID = new ObjectId('000000000000000000000001');

module.exports = {
    SETTINGS_DOCUMENT_ID,

    async up(db) {
        const existing = await db.listCollections({ name: 'settings' }).toArray();

        if (existing.length === 0) await db.createCollection('settings');

        await db
            .collection('settings')
            .updateOne(
                { _id: SETTINGS_DOCUMENT_ID },
                { $setOnInsert: { settings: {}, updated_at: new Date() } },
                { upsert: true },
            );
    },

    async down(db) {
        const existing = await db.listCollections({ name: 'settings' }).toArray();

        if (existing.length > 0) await db.collection('settings').drop();
    },
};
