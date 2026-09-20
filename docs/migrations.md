# Migrations

Schema changes and **all** index changes go through [migrate-mongo](https://github.com/seppevs/migrate-mongo).
The migrations live in [`migrations/`](../migrations), the connection string comes from `MONGO_URI` only
([migrate-mongo-config.js](../migrate-mongo-config.js)), and the applied set is recorded in
`migrations_changelog` with `migrations_lock` preventing two runners at once.

## Commands

| Command                            | Effect                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| `npm run migrate:status`           | What is applied and what is pending                                 |
| `npm run migrate:up`               | Apply everything pending (run **before** starting the new version)  |
| `npm run migrate:down`             | Roll back the last migration                                        |
| `npm run migrate:create -- <name>` | Scaffold `migrations/<timestamp>-<name>.js`                         |
| `npm run migrate:verify`           | CI guard: `up` → `status` → `down` against an in-memory replica set |

## Why indexes are not created by the app

`autoIndex` is off under `NODE_ENV=production`. An index therefore exists only because a migration created
it — building one implicitly on boot would stall a deploy on a large collection and would make every replica
race to build the same index.

The consequence is that an index must be declared **twice**: in the Mongoose schema (development, and as
documentation next to the fields it covers) and in a migration (every real environment). The `indexes`
e2e suite compares the schema declarations with the migration set and fails the build when they diverge, so
forgetting one half is caught before merge, not in production.

## Adding an index

1. Add `Schema.index({ … }, { name: '…' })` next to the fields in `src/**/schemas/*.schema.ts`.
2. `npm run migrate:create -- add-<collection>-<field>-index`.
3. In the new migration's `up`, `createIndex` with the **same key and the same explicit name**; in `down`,
   `dropIndex` by that name. Guard `down` so it is a no-op when the collection or the index is absent —
   look at [the initial migration](../migrations/20260905000000-initial-indexes.js) for the pattern.
4. `npm test` — the drift suite must pass.
5. `npm run migrate:verify` — proves `up` and `down` both work on a clean database.

Always name indexes explicitly. The generated name is what `down` and the drift check match on, and an
implicit name changes when the key order changes.

Build large indexes so they do not block: on a live collection prefer `createIndex` on a rolling secondary,
or accept the build window during a maintenance slot. `createIndex` is idempotent, so re-running a migration
against a database that already has the index is safe.

## Changing a TTL window

Each retention window is a constant at the top of the migration that creates its TTL index — archives,
analytics events, SMS, finished bookings and outbox events. Nothing reads them at runtime, and the Mongoose
schemas deliberately do not declare TTL at all. They are not environment variables on purpose: an existing
index ignores a new value, so changing one is always a migration.

To change retention: add a migration that runs `collMod` on the collection with the new
`expireAfterSeconds` for that index (MongoDB refuses a plain `createIndex` with different options on an
existing index). Roll it back the same way, with the previous value.

## Writing a data migration

- `up(db, client)` gets the raw driver. Use it — do not import the app's Mongoose models, which would tie a
  historical migration to today's schema.
- Make it idempotent: filter on the state you are changing (`{ field: { $exists: false } }`) rather than
  updating everything.
- Batch large backfills (`updateMany` in ranges by `_id`) instead of one unbounded update.
- Write a real `down`. `migrate:verify` runs it in CI, and a migration that cannot be rolled back turns a
  bad deploy into an incident.
- A migration that must be atomic across documents can open a session — the target is always a replica set.

## Deployment order

`npm run migrate:up` runs against the target database before the new version starts
([deployment.md](deployment.md)). Migrations must therefore be **backwards compatible with the version that
is still running**: add fields and indexes first, switch the code in the next release, drop the old field in
the one after.

### The one exception so far

[`20260911000000-bookings-collection.js`](../migrations/20260911000000-bookings-collection.js) moves
bookings out of the service and user documents and removes the embedded arrays in the same step, so the
previous version cannot serve bookings once it has run. It needs a short window rather than a rolling
deploy: stop the old replicas, run `migrate:up`, start the new ones. Its `down` rebuilds the embedded
arrays from the collection, so a rollback in that window is a rollback, not a data loss — but bookings
created after the switch are only restored if `down` runs before the old version writes again.

[`20260912000000-idempotency-keys.js`](../migrations/20260912000000-idempotency-keys.js) is back to the
ordinary kind: it only adds the `idempotency_keys` collection with its unique and TTL indexes, plus one
booking index, so the running version neither notices it nor needs it.

[`20260914000000-p3-catalogue-and-lifecycle.js`](../migrations/20260914000000-p3-catalogue-and-lifecycle.js)
is backwards compatible in the forward direction: it adds fields the running version ignores (`status` from
`enabled`, generated `slug`s, `active: true` on every booking), the four new collections and the new indexes,
and rebuilds `unique_booking_per_slot` as a partial index on `active: true` — the same key, so the old version's
inserts still hit it. Its `down` is **lossy by design**: a service in the trash is deleted with its bookings
(it was deleted from the user's point of view), and finished bookings are removed (the old model has no such
row and the plain unique index could not be rebuilt over them). Run it only as a real rollback.
