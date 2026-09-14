# Data model

MongoDB, accessed through Mongoose 8. Field names are `snake_case` everywhere — in the documents, in the
JSON, in the query parameters, in the JWT claims — so nothing is renamed between layers.

Every top-level schema uses `baseSchemaOptions(collection)`
([schema-options.ts](../src/common/database/schema-options.ts)): an explicit collection name, no `__v`, and timestamps mapped to
`created_at` / `updated_at`. Embedded schemas use `subSchemaOptions` (`_id: false`), so subdocuments carry
their own string `id` where they need one, not an ObjectId.

Relations are plain `ObjectId` fields; there are no Mongoose `ref` populates. A parent is deleted inside a
transaction and its children are removed by the hooks registered in the `CascadeRegistry`
([architecture.md](architecture.md)).

## Collections

| Collection           | Owns                                             | Key fields                                                                                                                                  |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`      | The tenant                                       | `main_label`, `main_category`, contact fields                                                                                               |
| `categories`         | Grouping inside an organization                  | `organization_id`, `position`, `label`, `enabled`                                                                                           |
| `services`           | The bookable/"apply" unit                        | `organization_id`, `category_id` (`null` = direct child), `position`, `label`, `enabled`, `value`, `options[]`                              |
| `news`               | Publications                                     | `organization_id`, `position`, `label`, `enabled`, `published_at`, `is_main`, `is_offer`, `expires_at`, `value`                             |
| `infosections`       | Static info blocks                               | `organization_id`, `position`, `label`, `enabled`, `control`, `value`                                                                       |
| `images`             | Uploaded files                                   | `organization_id`, storage key, mime, size                                                                                                  |
| `archives`           | Snapshots of finished bookings                   | `organization_id`, `service_id`, `type`, `payload` (Mixed)                                                                                  |
| `bookings`           | One booking of one slot                          | `id` (public uuid), `service_id`, `organization_id`, `option_id`, `slot_id`, `slot_date`, `slot_time`, `user_id`, `person`, `phone`, `info` |
| `users`              | Accounts                                         | `login`, `password_hash`, `phone`, `name`, `role`, `organization_ids[]`, `failed_login_attempts`, `last_failed_login_at`, `locked_until`    |
| `sessions`           | Refresh-token sessions                           | `user_id`, `family_id`, `refresh_token_hash`, `replaced_by`, `revoked_at`, `expires_at`                                                     |
| `verification_codes` | One-time codes                                   | `phone`, `code_hash`, `attempts`, `consumed_at`, `expires_at`                                                                               |
| `sms`                | Delivery log                                     | `phone`, `purpose`, `body`, `status`                                                                                                        |
| `analytics_events`   | Business events (old `Statistics`)               | `type` + denormalised actor/organization/service labels                                                                                     |
| `job_locks`          | Scheduler lease and last run                     | one document per job name; lease plus `last_status`, `last_error`, `last_duration_ms` ([jobs.md](jobs.md))                                  |
| `rate_limits`        | Throttler counters when `THROTTLE_STORAGE=mongo` | `key`, `count`, `expires_at`                                                                                                                |
| `sms_counters`       | Global SMS budget windows                        | `_id` = `sms:<hour\|day>:<bucket>`, `count`, `expires_at`                                                                                   |
| `idempotency_keys`   | Remembered writes per `Idempotency-Key`          | `scope`, `key`, `user_id`, `request_hash`, `status`, `response`, `expires_at`                                                               |

## The service tree and its bookings

A service document carries the bookable structure; the bookings themselves are their own collection:

```
services
└─ options[]                 id, label, service_type, enabled, recurrent_dates[]
   └─ slots[]                id, label, child_type, value
      └─ value
         ├─ date, description, link, price
         ├─ limit, booked_count                  (slot booked as a whole)
         └─ time[]                               (slot booked per time)
            └─ time, limit, booked_count

bookings                     one document per booking
  id, service_id, organization_id, option_id, slot_id, slot_date, slot_time,
  user_id, person, phone, info, created_at
```

Bookings used to live inside `options[].slots[]` **and** be mirrored in `users.bookings[]`. That put every
booking of a service into one 16 MB document, funnelled all of its write concurrency through that document,
made "the bookings of one user" a scan over a multikey path, and required a nightly job to reconcile the two
copies. Four things to know about the shape that replaced it:

- **Capacity is a counter, not a length.** `booked_count` stays on the slot so a booking can be accepted by
  one conditional update (`booked_count < limit`) in the same transaction as the insert. Never derive
  capacity from a count of booking documents.
- **Duplicates are an index, not a check.** `{ service_id, option_id, slot_id, slot_time, user_id }` is
  unique; a second identical booking fails the insert and surfaces as `409 BOOKING_ALREADY_EXISTS`.
- **Never rewrite `options` wholesale.** Jobs and the sub-resource routes use targeted `$push` / `$pull` /
  `$inc` on the exact path, so a booking made concurrently with a job cannot be clobbered.
- **Bookings are also a resource of their own.** `GET /bookings`, `GET /me/bookings`,
  `GET /services/:id/bookings` and `DELETE /bookings/:id` read and write the collection directly, so a
  client no longer downloads a whole service document to see or cancel one booking.
- **The service document holds no personal data.** Bookings are read from their own collection and grafted
  into the response only for the organization's admins and super-admins; everyone else gets
  `{ "status": "reserved" }` markers rebuilt from `booked_count`, and a public route issues no booking query
  at all.

`users.password_hash`, `verification_codes.code_hash` and `sessions.refresh_token_hash` are `select: false` —
they are not even loaded unless a code path asks.

## Indexes

`autoIndex` is **off in production**. Indexes exist because a migration created them, and the Mongoose
declarations are there for development and for documentation. The `indexes` e2e suite compares the two
and fails when they diverge, so a new index must be added in both places — see
[migrations.md](migrations.md).

Shape of the set:

- **Listing** — every ordered child collection (`categories`, `news`, `infosections`) has
  `{ organization_id: 1, position: 1 }`; services add `{ organization_id, category_id, position }`,
  `{ category_id }` and `{ organization_id, enabled, position }`. `images` and `archives` carry no
  `position` and are listed newest first, by `{ organization_id: 1, created_at: -1 }`; `images` also has
  `{ name: 1 }`, which is what makes the `storage_gc` batch lookup an index hit rather than a scan.
- **Bookings** — `{ user_id, created_at }`, `{ service_id, created_at }` and
  `{ organization_id, created_at }` cover the three cascade paths and "my bookings";
  `{ organization_id, slot_date }` serves a desk asking for one day; `id` is unique, and
  `{ service_id, option_id, slot_id, slot_time, user_id }` is the uniqueness guard described above.
- **Idempotency** — `idempotency_keys` is unique on `{ scope, user_id, key }`: claiming that key _is_ the
  atomic operation that makes a retried booking replay instead of running twice.
- **Uniqueness** — `users.login` and `users.phone` are unique with a partial filter on
  `{ $type: 'string' }`, so any number of accounts may have no login or no phone.
- **Partial** — `news.is_main` and `news.is_offer` are indexed only for the `true` documents.
- **Text** — `organizations.main_label` for search.
- **TTL** — `sessions.expires_at`, `verification_codes.expires_at`, `rate_limits.expires_at` (all
  `expireAfterSeconds: 0`), plus `sms_counters.expires_at` and `idempotency_keys.expires_at`; `archives.created_at` at
  `ARCHIVE_RETENTION_DAYS`; `analytics_events.created_at` at `ANALYTICS_RETENTION_DAYS` and
  `sms.created_at` at `SMS_RETENTION_DAYS`, because those rows carry citizen phone numbers and names.
  Deleting an account also strips `user_id`, `user_name` and `user_phone` from its analytics events, so the
  statistics survive the account without pointing at a person.

TTL windows live in the migration only, never in the schema, so development and production cannot drift.
