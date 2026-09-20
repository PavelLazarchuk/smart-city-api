const SMS_RETENTION_DAYS = Number(process.env.SMS_RETENTION_DAYS || 365);

const BOOKING_INDEXES = [
    { key: { id: 1 }, name: 'id_1', unique: true },
    {
        key: { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, user_id: 1 },
        name: 'unique_booking_per_slot',
        unique: true,
    },
    { key: { user_id: 1, created_at: -1 }, name: 'user_id_1_created_at_-1' },
    { key: { service_id: 1, created_at: -1 }, name: 'service_id_1_created_at_-1' },
    { key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' },
];

const EXTRA_INDEXES = {
    services: [
        {
            key: { organization_id: 1, enabled: 1, position: 1 },
            name: 'organization_id_1_enabled_1_position_1',
        },
    ],
    sms: [
        {
            key: { created_at: 1 },
            name: 'created_at_ttl',
            expireAfterSeconds: SMS_RETENTION_DAYS * 24 * 60 * 60,
        },
    ],
    sms_counters: [{ key: { expires_at: 1 }, name: 'expires_at_1', expireAfterSeconds: 0 }],
};

function bookingsOf(service) {
    const rows = [];
    const label = (service.value && service.value.heading_value) || service.label || '';

    for (const option of service.options || []) {
        for (const slot of (option && option.slots) || []) {
            const value = slot.value || {};
            const common = {
                service_id: service._id,
                organization_id: service.organization_id,
                option_id: option.id,
                slot_id: slot.id,
                child_type: slot.child_type,
                slot_date: value.date === undefined ? null : value.date,
                service_label: label,
            };

            for (const booking of value.bookings || []) {
                rows.push({ ...common, ...fields(booking), slot_time: null });
            }

            for (const entry of value.time || []) {
                for (const booking of entry.bookings || []) {
                    rows.push({ ...common, ...fields(booking), slot_time: entry.time });
                }
            }
        }
    }

    return rows;
}

function fields(booking) {
    const createdAt = booking.created_at ? new Date(booking.created_at) : new Date();

    return {
        id: booking.id,
        user_id: booking.user_id,
        person: booking.person || '',
        phone: booking.phone || '',
        info: booking.info || '',
        created_at: createdAt,
        updated_at: createdAt,
    };
}

module.exports = {
    INDEXES: { bookings: BOOKING_INDEXES, ...EXTRA_INDEXES },

    async up(db) {
        const existing = await db.listCollections({ name: 'bookings' }).toArray();

        if (existing.length === 0) await db.createCollection('bookings');

        const services = db.collection('services').find({ 'options.0': { $exists: true } });
        let batch = [];
        let migrated = 0;

        for await (const service of services) {
            batch.push(...bookingsOf(service));

            if (batch.length < 500) continue;

            await db.collection('bookings').insertMany(batch, { ordered: false });
            migrated += batch.length;
            batch = [];
        }

        if (batch.length > 0) {
            await db.collection('bookings').insertMany(batch, { ordered: false });
            migrated += batch.length;
        }

        for (const { key, ...options } of BOOKING_INDEXES) {
            await db.collection('bookings').createIndex(key, options);
        }

        for (const [collection, indexes] of Object.entries(EXTRA_INDEXES)) {
            const present = await db.listCollections({ name: collection }).toArray();

            if (present.length === 0) await db.createCollection(collection);

            for (const { key, ...options } of indexes) {
                await db.collection(collection).createIndex(key, options);
            }
        }

        await db
            .collection('services')
            .updateMany({}, { $unset: { 'options.$[].slots.$[].value.bookings': '' } });
        // The inner `$[]` needs `value.time` to exist, so the slots without one are filtered out.
        await db
            .collection('services')
            .updateMany(
                { 'options.slots.value.time': { $exists: true } },
                { $unset: { 'options.$[].slots.$[slot].value.time.$[].bookings': '' } },
                { arrayFilters: [{ 'slot.value.time': { $exists: true } }] },
            );
        await db.collection('users').updateMany({}, { $unset: { bookings: '' } });

        console.log(`bookings migrated: ${migrated}`);
    },

    async down(db) {
        const bookings = await db.collection('bookings').find({}).toArray();

        for (const booking of bookings) {
            const embedded = {
                id: booking.id,
                user_id: booking.user_id,
                person: booking.person,
                phone: booking.phone,
                info: booking.info,
                created_at: booking.created_at,
            };
            const path = booking.slot_time
                ? 'options.$[option].slots.$[slot].value.time.$[entry].bookings'
                : 'options.$[option].slots.$[slot].value.bookings';
            const arrayFilters = [{ 'option.id': booking.option_id }, { 'slot.id': booking.slot_id }];

            if (booking.slot_time) arrayFilters.push({ 'entry.time': booking.slot_time });

            await db
                .collection('services')
                .updateOne({ _id: booking.service_id }, { $push: { [path]: embedded } }, { arrayFilters });
            await db.collection('users').updateOne(
                { _id: booking.user_id },
                {
                    $push: {
                        bookings: {
                            id: booking.id,
                            service_id: booking.service_id,
                            organization_id: booking.organization_id,
                            option_id: booking.option_id,
                            slot_id: booking.slot_id,
                            child_type: booking.child_type,
                            service_label: booking.service_label,
                            date: booking.slot_date === null ? undefined : booking.slot_date,
                            time: booking.slot_time === null ? undefined : booking.slot_time,
                            created_at: booking.created_at,
                        },
                    },
                },
            );
        }

        for (const [collection, indexes] of Object.entries(EXTRA_INDEXES)) {
            const present = await db.listCollections({ name: collection }).toArray();

            if (present.length === 0) continue;

            const current = await db.collection(collection).indexes();

            for (const { name } of indexes) {
                if (current.some((index) => index.name === name))
                    await db.collection(collection).dropIndex(name);
            }
        }

        const existing = await db.listCollections({ name: 'bookings' }).toArray();

        if (existing.length > 0) await db.collection('bookings').drop();
    },
};
