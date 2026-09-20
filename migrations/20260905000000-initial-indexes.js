// Pinned here, not in the environment: an existing TTL index only changes through a later collMod migration.
const ARCHIVE_RETENTION_DAYS = 30;
const ANALYTICS_RETENTION_DAYS = 365;

const INDEXES = {
    organizations: [
        { key: { main_category: 1 }, name: 'main_category_1' },
        { key: { created_at: -1 }, name: 'created_at_-1' },
        { key: { main_label: 'text' }, name: 'main_label_text' },
    ],
    news: [
        { key: { organization_id: 1, position: 1 }, name: 'organization_id_1_position_1' },
        {
            key: { is_main: 1, created_at: -1 },
            name: 'is_main_1_created_at_-1',
            partialFilterExpression: { is_main: true },
        },
        {
            key: { is_offer: 1, created_at: -1 },
            name: 'is_offer_1_created_at_-1',
            partialFilterExpression: { is_offer: true },
        },
        { key: { expires_at: 1 }, name: 'expires_at_1' },
    ],
    infosections: [{ key: { organization_id: 1, position: 1 }, name: 'organization_id_1_position_1' }],
    categories: [{ key: { organization_id: 1, position: 1 }, name: 'organization_id_1_position_1' }],
    services: [
        {
            key: { organization_id: 1, category_id: 1, position: 1 },
            name: 'organization_id_1_category_id_1_position_1',
        },
        { key: { category_id: 1 }, name: 'category_id_1' },
    ],
    users: [
        {
            key: { login: 1 },
            name: 'login_1',
            unique: true,
            partialFilterExpression: { login: { $type: 'string' } },
        },
        {
            key: { phone: 1 },
            name: 'phone_1',
            unique: true,
            partialFilterExpression: { phone: { $type: 'string' } },
        },
        { key: { organization_ids: 1 }, name: 'organization_ids_1' },
    ],
    sessions: [
        { key: { user_id: 1 }, name: 'user_id_1' },
        { key: { family_id: 1 }, name: 'family_id_1' },
        { key: { expires_at: 1 }, name: 'expires_at_1', expireAfterSeconds: 0 },
    ],
    verification_codes: [
        { key: { phone: 1 }, name: 'phone_1' },
        { key: { expires_at: 1 }, name: 'expires_at_1', expireAfterSeconds: 0 },
    ],
    images: [{ key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' }],
    archives: [
        { key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' },
        { key: { service_id: 1 }, name: 'service_id_1' },
        {
            key: { created_at: 1 },
            name: 'created_at_1',
            expireAfterSeconds: ARCHIVE_RETENTION_DAYS * 24 * 60 * 60,
        },
    ],
    sms: [
        { key: { created_at: -1 }, name: 'created_at_-1' },
        { key: { phone: 1, created_at: -1 }, name: 'phone_1_created_at_-1' },
    ],
    analytics_events: [
        {
            key: { created_at: -1 },
            name: 'created_at_-1',
            expireAfterSeconds: ANALYTICS_RETENTION_DAYS * 24 * 60 * 60,
        },
        { key: { type: 1, created_at: -1 }, name: 'type_1_created_at_-1' },
        { key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' },
        { key: { user_id: 1 }, name: 'user_id_1' },
    ],
    job_locks: [],
    rate_limits: [{ key: { expires_at: 1 }, name: 'expires_at_1', expireAfterSeconds: 0 }],
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
