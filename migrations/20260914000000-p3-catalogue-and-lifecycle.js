// Pinned here, not in the environment: an existing TTL index only changes through a later collMod migration.
const BOOKING_HISTORY_RETENTION_DAYS = 365;
const OUTBOX_RETENTION_DAYS = 30;

const SLUG_PARTIAL = { slug: { $type: 'string' } };

const BOOKING_UNIQUE_BEFORE = {
    key: { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, user_id: 1 },
    name: 'unique_booking_per_slot',
    unique: true,
};
const BOOKING_UNIQUE_AFTER = { ...BOOKING_UNIQUE_BEFORE, partialFilterExpression: { active: true } };

const INDEXES = {
    services: [
        {
            key: { organization_id: 1, slug: 1 },
            name: 'unique_slug_per_organization',
            unique: true,
            partialFilterExpression: SLUG_PARTIAL,
        },
        { key: { status: 1, deleted_at: 1 }, name: 'status_1_deleted_at_1' },
        { key: { tags: 1 }, name: 'tags_1' },
        { key: { deleted_at: 1 }, name: 'deleted_at_1' },
        { key: { location: '2dsphere' }, name: 'location_2dsphere' },
        {
            key: {
                description: 'text',
                label: 'text',
                tags: 'text',
                'value.heading_value': 'text',
                'value.text_value': 'text',
            },
            name: 'service_text',
            weights: { description: 3, label: 10, tags: 8, 'value.heading_value': 6, 'value.text_value': 1 },
        },
    ],
    bookings: [
        BOOKING_UNIQUE_AFTER,
        {
            key: { active: 1, slot_date: 1, reminder_sent_at: 1 },
            name: 'active_1_slot_date_1_reminder_sent_at_1',
        },
        {
            key: { organization_id: 1, status: 1, slot_date: 1 },
            name: 'organization_id_1_status_1_slot_date_1',
        },
        {
            key: { finished_at: 1 },
            name: 'finished_at_ttl',
            expireAfterSeconds: BOOKING_HISTORY_RETENTION_DAYS * 24 * 60 * 60,
        },
    ],
    waitlist: [
        { key: { id: 1 }, name: 'id_1', unique: true },
        {
            key: { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, user_id: 1 },
            name: 'unique_waitlist_per_slot',
            unique: true,
        },
        {
            key: { service_id: 1, option_id: 1, slot_id: 1, slot_time: 1, status: 1, created_at: 1 },
            name: 'service_id_1_option_id_1_slot_id_1_slot_time_1_status_1_created_at_1',
        },
        { key: { user_id: 1, created_at: -1 }, name: 'user_id_1_created_at_-1' },
        { key: { organization_id: 1 }, name: 'organization_id_1' },
    ],
    outbox_events: [
        { key: { id: 1 }, name: 'id_1', unique: true },
        { key: { status: 1, next_attempt_at: 1 }, name: 'status_1_next_attempt_at_1' },
        { key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' },
        {
            key: { created_at: 1 },
            name: 'created_at_ttl',
            expireAfterSeconds: OUTBOX_RETENTION_DAYS * 24 * 60 * 60,
        },
    ],
    webhooks: [
        { key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' },
        { key: { enabled: 1, events: 1 }, name: 'enabled_1_events_1' },
    ],
    service_revisions: [
        { key: { service_id: 1, created_at: -1 }, name: 'service_id_1_created_at_-1' },
        { key: { organization_id: 1, created_at: -1 }, name: 'organization_id_1_created_at_-1' },
    ],
    news: [
        {
            key: { organization_id: 1, slug: 1 },
            name: 'unique_slug_per_organization',
            unique: true,
            partialFilterExpression: SLUG_PARTIAL,
        },
        { key: { rubric: 1, date: -1 }, name: 'rubric_1_date_-1' },
        { key: { publish_at: 1 }, name: 'publish_at_1' },
        {
            key: { label: 'text', 'value.heading_value': 'text', 'value.text_value': 'text' },
            name: 'news_text',
            weights: { label: 10, 'value.heading_value': 6, 'value.text_value': 1 },
        },
    ],
    organizations: [
        { key: { status: 1 }, name: 'status_1' },
        { key: { location: '2dsphere' }, name: 'location_2dsphere' },
    ],
};

const NEW_COLLECTIONS = ['waitlist', 'outbox_events', 'webhooks', 'service_revisions'];

const TRANSLIT = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'yo',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    ў: 'u',
    і: 'i',
    ґ: 'g',
    є: 'ye',
    ї: 'yi',
};

function slugify(input) {
    const latin = [...String(input || '').toLowerCase()].map((char) => TRANSLIT[char] ?? char).join('');

    return latin
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');
}

async function backfillSlugs(collection, labelOf) {
    const taken = new Map();
    const withSlug = collection.find(
        { slug: { $type: 'string' } },
        { projection: { organization_id: 1, slug: 1 } },
    );

    for await (const row of withSlug) {
        const key = String(row.organization_id);

        if (!taken.has(key)) taken.set(key, new Set());

        taken.get(key).add(row.slug);
    }

    const rows = collection.find({ slug: { $not: { $type: 'string' } } });
    let updated = 0;

    for await (const row of rows) {
        const key = String(row.organization_id);

        if (!taken.has(key)) taken.set(key, new Set());

        const used = taken.get(key);
        const base = slugify(labelOf(row)) || 'item';
        let slug = base;

        for (let n = 2; used.has(slug); n += 1) slug = `${base.slice(0, 80 - String(n).length - 1)}-${n}`;

        used.add(slug);
        await collection.updateOne({ _id: row._id }, { $set: { slug } });
        updated += 1;
    }

    return updated;
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
        await db.collection('services').updateMany({ status: { $exists: false } }, [
            {
                $set: {
                    status: { $cond: [{ $eq: ['$enabled', true] }, 'published', 'draft'] },
                    published_at: { $cond: [{ $eq: ['$enabled', true] }, '$$NOW', null] },
                },
            },
        ]);
        await db.collection('services').updateMany({}, [
            {
                $set: {
                    tags: { $ifNull: ['$tags', []] },
                    working_hours: { $ifNull: ['$working_hours', []] },
                    holidays: { $ifNull: ['$holidays', []] },
                    blackout_dates: { $ifNull: ['$blackout_dates', []] },
                    form_fields: { $ifNull: ['$form_fields', []] },
                    required_documents: { $ifNull: ['$required_documents', []] },
                    booking_policy: { $ifNull: ['$booking_policy', { requires_confirmation: false }] },
                    duration_minutes: { $ifNull: ['$duration_minutes', null] },
                    buffer_minutes: { $ifNull: ['$buffer_minutes', null] },
                    price: { $ifNull: ['$price', null] },
                    deleted_at: { $ifNull: ['$deleted_at', null] },
                },
            },
        ]);
        const serviceSlugs = await backfillSlugs(
            db.collection('services'),
            (row) => (row.value && row.value.heading_value) || row.label,
        );

        await db.collection('bookings').updateMany(
            { status: { $exists: false } },
            {
                $set: {
                    status: 'confirmed',
                    active: true,
                    fields: {},
                    documents: [],
                    confirmed_at: null,
                    finished_at: null,
                    status_changed_by: null,
                    reminder_sent_at: null,
                },
            },
        );
        await dropIndexes(db, 'bookings', [BOOKING_UNIQUE_BEFORE.name]);

        await db
            .collection('news')
            .updateMany({ publish_at: { $exists: false } }, { $set: { publish_at: null } });
        const newsSlugs = await backfillSlugs(
            db.collection('news'),
            (row) => (row.value && row.value.heading_value) || row.label,
        );
        await db.collection('organizations').updateMany({ status: { $exists: false } }, [
            {
                $set: {
                    status: 'active',
                    closed_until: null,
                    working_hours: { $ifNull: ['$working_hours', []] },
                    holidays: { $ifNull: ['$holidays', []] },
                },
            },
        ]);

        for (const [collection, indexes] of Object.entries(INDEXES))
            await createIndexes(db, collection, indexes);

        console.log(`slugs generated: services ${serviceSlugs}, news ${newsSlugs}`);
    },

    async down(db) {
        for (const [collection, indexes] of Object.entries(INDEXES)) {
            await dropIndexes(
                db,
                collection,
                indexes.map((index) => index.name),
            );
        }

        const trashed = await db
            .collection('services')
            .find({ deleted_at: { $ne: null } }, { projection: { _id: 1 } })
            .toArray();

        if (trashed.length > 0) {
            const ids = trashed.map((row) => row._id);
            await db.collection('bookings').deleteMany({ service_id: { $in: ids } });
            await db.collection('archives').deleteMany({ service_id: { $in: ids } });
            await db.collection('services').deleteMany({ _id: { $in: ids } });
        }

        await db.collection('bookings').deleteMany({ active: false });
        await db.collection('bookings').updateMany(
            {},
            {
                $unset: {
                    status: '',
                    active: '',
                    fields: '',
                    documents: '',
                    confirmed_at: '',
                    finished_at: '',
                    status_changed_by: '',
                    reminder_sent_at: '',
                },
            },
        );

        const bookings = await db.listCollections({ name: 'bookings' }).toArray();

        if (bookings.length > 0) {
            const { key, ...options } = BOOKING_UNIQUE_BEFORE;
            await db.collection('bookings').createIndex(key, options);
        }

        await db.collection('services').updateMany(
            {},
            {
                $unset: {
                    slug: '',
                    status: '',
                    published_at: '',
                    description: '',
                    tags: '',
                    duration_minutes: '',
                    buffer_minutes: '',
                    price: '',
                    currency: '',
                    address: '',
                    location: '',
                    working_hours: '',
                    holidays: '',
                    blackout_dates: '',
                    booking_policy: '',
                    form_fields: '',
                    required_documents: '',
                    deleted_at: '',
                },
            },
        );
        await db.collection('news').updateMany({}, { $unset: { slug: '', rubric: '', publish_at: '' } });
        await db.collection('organizations').updateMany(
            {},
            {
                $unset: {
                    status: '',
                    closed_reason: '',
                    closed_until: '',
                    address: '',
                    location: '',
                    working_hours: '',
                    holidays: '',
                },
            },
        );

        for (const collection of NEW_COLLECTIONS) {
            const existing = await db.listCollections({ name: collection }).toArray();

            if (existing.length > 0) await db.collection(collection).drop();
        }
    },
};
