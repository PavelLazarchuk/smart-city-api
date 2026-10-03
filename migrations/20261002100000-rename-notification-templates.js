const FROM = 'notification_templates';
const TO = 'channel_templates';

const INDEXES = {
    channel_templates: [
        { key: { organization_id: 1, key: 1 }, name: 'unique_template_per_organization', unique: true },
    ],
};

async function exists(db, name) {
    return (await db.listCollections({ name }).toArray()).length > 0;
}

async function move(db) {
    if (!(await exists(db, FROM))) return;

    if (!(await exists(db, TO))) {
        await db.collection(FROM).rename(TO);

        return;
    }

    for await (const { _id, ...row } of db.collection(FROM).find()) {
        await db
            .collection(TO)
            .updateOne(
                { organization_id: row.organization_id, key: row.key },
                { $setOnInsert: row },
                { upsert: true },
            );
    }

    await db.collection(FROM).drop();
}

module.exports = {
    INDEXES,

    async up(db) {
        await move(db);

        if (!(await exists(db, TO))) await db.createCollection(TO);

        for (const { key, ...options } of INDEXES[TO]) {
            await db.collection(TO).createIndex(key, options);
        }
    },

    async down(db) {
        if (!(await exists(db, TO))) return;

        if (!(await exists(db, FROM))) {
            await db.collection(TO).rename(FROM);

            return;
        }

        const current = await db.collection(TO).indexes();

        for (const { name } of INDEXES[TO]) {
            if (current.some((index) => index.name === name)) await db.collection(TO).dropIndex(name);
        }
    },
};
