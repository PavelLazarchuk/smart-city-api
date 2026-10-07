const { randomInt } = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 5;

const INDEXES = {
    bookings: [
        {
            key: { checkin_code: 1 },
            name: 'unique_active_checkin_code',
            unique: true,
            partialFilterExpression: { active: true, checkin_code: { $type: 'string' } },
        },
        { key: { checkin_code: 1, created_at: -1 }, name: 'checkin_code_1_created_at_-1' },
        { key: { service_id: 1, status: 1, starts_at: 1 }, name: 'service_id_1_status_1_starts_at_1' },
    ],
};

function generateCode() {
    let code = '';

    for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];

    return code;
}

async function assignCodes(db) {
    const bookings = db.collection('bookings');
    const missing = bookings.find(
        { active: true, child_type: { $ne: 'callback' }, checkin_code: { $not: { $type: 'string' } } },
        { projection: { _id: 1 } },
    );

    for await (const { _id } of missing) {
        for (let attempt = 1; ; attempt += 1) {
            try {
                await bookings.updateOne({ _id, active: true }, { $set: { checkin_code: generateCode() } });
                break;
            } catch (error) {
                if (error.code !== 11000 || attempt >= CODE_ATTEMPTS) throw error;
            }
        }
    }
}

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

        await assignCodes(db);

        if ((await db.listCollections({ name: 'sms' }).toArray()).length > 0)
            await db
                .collection('sms')
                .updateMany({ channel: { $exists: false } }, { $set: { channel: 'sms' } });
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
