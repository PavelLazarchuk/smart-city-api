const DUPLICATE_KEY = 11000;
const BATCH = 500;

const INDEXES = {
    slots: [
        {
            key: { service_id: 1, option_id: 1, id: 1 },
            name: 'unique_slot_per_option',
            unique: true,
        },
        { key: { organization_id: 1 }, name: 'organization_id_1' },
        {
            key: { 'value.date': 1 },
            name: 'value.date_1',
            partialFilterExpression: { 'value.date': { $type: 'string' } },
        },
    ],
};

async function insertIgnoringDuplicates(db, rows) {
    if (rows.length === 0) return 0;

    try {
        const result = await db.collection('slots').insertMany(rows, { ordered: false });

        return result.insertedCount;
    } catch (error) {
        const failures = [].concat(error.writeErrors || []);

        if (failures.length === 0 || failures.some((failure) => failure.code !== DUPLICATE_KEY)) throw error;

        return error.result ? error.result.insertedCount : rows.length - failures.length;
    }
}

function valueOf(slot) {
    const { time, ...value } = slot.value || {};

    return slot.child_type === 'date_time' ? { ...value, time: time || [] } : value;
}

module.exports = {
    INDEXES,

    async up(db) {
        const existing = await db.listCollections({ name: 'slots' }).toArray();

        if (existing.length === 0) await db.createCollection('slots');

        for (const { key, ...options } of INDEXES.slots)
            await db.collection('slots').createIndex(key, options);

        const services = db
            .collection('services')
            .find(
                { 'options.slots.0': { $exists: true } },
                { projection: { organization_id: 1, options: 1 } },
            );
        let batch = [];
        let copied = 0;

        for await (const service of services) {
            const now = new Date();

            for (const option of service.options || []) {
                for (const slot of (option && option.slots) || []) {
                    batch.push({
                        service_id: service._id,
                        organization_id: service.organization_id,
                        option_id: option.id,
                        id: slot.id,
                        label: slot.label,
                        child_type: slot.child_type,
                        value: valueOf(slot),
                        created_at: now,
                        updated_at: now,
                    });
                }
            }

            if (batch.length < BATCH) continue;

            copied += await insertIgnoringDuplicates(db, batch);
            batch = [];
        }

        copied += await insertIgnoringDuplicates(db, batch);
        await db
            .collection('services')
            .updateMany({ 'options.slots': { $exists: true } }, { $unset: { 'options.$[].slots': '' } });

        console.log(`slots moved: ${copied}`);
    },

    async down(db) {
        const existing = await db.listCollections({ name: 'slots' }).toArray();

        if (existing.length === 0) return;

        const services = db.collection('services').find({}, { projection: { options: 1 } });

        for await (const service of services) {
            const slots = await db
                .collection('slots')
                .find({ service_id: service._id })
                .sort({ _id: 1 })
                .toArray();
            const options = (service.options || []).map((option) => ({
                ...option,
                slots: slots
                    .filter((slot) => slot.option_id === option.id)
                    .map((slot) => ({
                        id: slot.id,
                        label: slot.label,
                        child_type: slot.child_type,
                        value: slot.value,
                    })),
            }));
            await db.collection('services').updateOne({ _id: service._id }, { $set: { options } });
        }

        await db.collection('slots').drop();
    },
};
