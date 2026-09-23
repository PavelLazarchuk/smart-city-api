const DEFAULT_TIME_ZONE = process.env.JOBS_TIMEZONE || 'UTC';

const SEARCH_DEFAULT_LANGUAGE = 'english';

const SERVICE_TEXT = {
    key: {
        description: 'text',
        label: 'text',
        tags: 'text',
        'value.heading_value': 'text',
        'value.text_value': 'text',
    },
    name: 'service_text',
    default_language: SEARCH_DEFAULT_LANGUAGE,
    weights: { description: 3, label: 10, tags: 8, 'value.heading_value': 6, 'value.text_value': 1 },
};

const NEWS_TEXT = {
    key: { label: 'text', 'value.heading_value': 'text', 'value.text_value': 'text' },
    name: 'news_text',
    default_language: SEARCH_DEFAULT_LANGUAGE,
    weights: { label: 10, 'value.heading_value': 6, 'value.text_value': 1 },
};

const INDEXES = {
    bookings: [
        {
            key: { active: 1, starts_at: 1, reminder_sent_at: 1 },
            name: 'active_1_starts_at_1_reminder_sent_at_1',
        },
    ],
    services: [SERVICE_TEXT],
    news: [NEWS_TEXT],
};

function offsetMinutes(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(instant);
    const read = (type) => Number(parts.find((part) => part.type === type).value);
    const wall = Date.UTC(
        read('year'),
        read('month') - 1,
        read('day'),
        read('hour'),
        read('minute'),
        read('second'),
    );

    return Math.round((wall - (instant.getTime() - instant.getMilliseconds())) / 60000);
}

function instantIn(date, time, timeZone) {
    const [year, month, day] = date.split('-').map(Number);
    const [hours = 0, minutes = 0] = (time || '00:00').split(':').map(Number);
    const wall = Date.UTC(year, month - 1, day, hours, minutes);
    const first = wall - offsetMinutes(new Date(wall), timeZone) * 60000;

    return new Date(wall - offsetMinutes(new Date(first), timeZone) * 60000);
}

async function createIndexes(db, collection, indexes) {
    const existing = await db.listCollections({ name: collection }).toArray();

    if (existing.length === 0) await db.createCollection(collection);

    for (const { key, ...options } of indexes) await db.collection(collection).createIndex(key, options);
}

async function dropIndexes(db, collection, names) {
    const existing = await db.listCollections({ name: collection }).toArray();

    if (existing.length === 0) return;

    const current = await db.collection(collection).indexes();

    for (const name of names) {
        if (current.some((index) => index.name === name)) await db.collection(collection).dropIndex(name);
    }
}

module.exports = {
    INDEXES,

    async up(db) {
        await db
            .collection('organizations')
            .updateMany(
                { timezone: { $not: { $type: 'string' } } },
                { $set: { timezone: DEFAULT_TIME_ZONE } },
            );

        const zones = new Map();
        const organizations = db.collection('organizations').find({}, { projection: { timezone: 1 } });

        for await (const row of organizations) zones.set(String(row._id), row.timezone || DEFAULT_TIME_ZONE);

        const bookings = db
            .collection('bookings')
            .find(
                { starts_at: { $exists: false } },
                { projection: { organization_id: 1, slot_date: 1, slot_time: 1 } },
            );
        let dated = 0;
        let undated = 0;

        for await (const row of bookings) {
            const zone = zones.get(String(row.organization_id)) || DEFAULT_TIME_ZONE;
            const startsAt =
                typeof row.slot_date === 'string' && row.slot_date
                    ? instantIn(row.slot_date, row.slot_time, zone)
                    : null;
            await db.collection('bookings').updateOne({ _id: row._id }, { $set: { starts_at: startsAt } });

            if (startsAt) dated += 1;
            else undated += 1;
        }

        await dropIndexes(db, 'services', [SERVICE_TEXT.name]);
        await dropIndexes(db, 'news', [NEWS_TEXT.name]);

        for (const [collection, indexes] of Object.entries(INDEXES))
            await createIndexes(db, collection, indexes);

        console.log(`starts_at backfilled: ${dated} dated, ${undated} undated`);
    },

    async down(db) {
        for (const [collection, indexes] of Object.entries(INDEXES)) {
            await dropIndexes(
                db,
                collection,
                indexes.map((index) => index.name),
            );
        }

        await db.collection('organizations').updateMany({}, { $unset: { timezone: '' } });
        await db.collection('bookings').updateMany({}, { $unset: { starts_at: '' } });

        for (const [collection, index] of [
            ['services', SERVICE_TEXT],
            ['news', NEWS_TEXT],
        ]) {
            const existing = await db.listCollections({ name: collection }).toArray();

            if (existing.length === 0) continue;

            const { key, name, weights } = index;
            await db.collection(collection).createIndex(key, { name, weights });
        }
    },
};
