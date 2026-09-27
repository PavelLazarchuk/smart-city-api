const INDEXES = {};

module.exports = {
    INDEXES,

    async up(db) {
        await db
            .collection('slots')
            .updateMany({ child_type: 'delivery' }, { $set: { child_type: 'pickup' } });
        await db
            .collection('bookings')
            .updateMany(
                { slot_end: { $exists: false } },
                { $set: { slot_end: null, ends_at: null, address: null } },
            );
    },

    async down(db) {
        await db
            .collection('slots')
            .updateMany({ child_type: { $in: ['pickup', 'courier'] } }, { $set: { child_type: 'delivery' } });
        await db
            .collection('bookings')
            .updateMany({}, { $unset: { slot_end: '', ends_at: '', address: '' } });
    },
};
