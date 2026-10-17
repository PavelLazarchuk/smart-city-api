module.exports = {
    async up(db) {
        const existing = await db.listCollections({ name: 'analytics_events' }).toArray();

        if (existing.length === 0) return;

        await db
            .collection('analytics_events')
            .updateMany(
                { $or: [{ user_name: { $exists: true } }, { user_phone: { $exists: true } }] },
                { $unset: { user_name: '', user_phone: '' } },
            );
    },

    async down() {},
};
