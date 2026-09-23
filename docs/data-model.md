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

| Collection           | Owns                                             | Key fields                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`      | The tenant                                       | `main_label`, `main_category`, `main_image`, `status` (`active` \| `temporarily_closed`), `closed_reason`, `closed_until`, `address`, `location`, `working_hours[]`, `holidays[]`, `timezone`                                                                                                                                                                                             |
| `categories`         | Grouping inside an organization                  | `organization_id`, `position`, `label`, `enabled`                                                                                                                                                                                                                                                                                                                                         |
| `services`           | The bookable/"apply" unit                        | `organization_id`, `category_id` (`null` = direct child), `position`, `label`, `slug`, `status`, `published_at`, `enabled`, `description`, `tags[]`, `duration_minutes`, `buffer_minutes`, `price`, `currency`, `address`, `location`, `working_hours[]`, `holidays[]`, `blackout_dates[]`, `booking_policy`, `form_fields[]`, `required_documents[]`, `value`, `options[]`, `deleted_at` |
| `slots`              | One slot of one service option                   | `service_id`, `organization_id`, `option_id`, `id` (uuid, unique per option), `label`, `child_type`, `value` (`date`, `time[]`, `limit`, `booked_count`, …)                                                                                                                                                                                                                               |
| `service_revisions`  | Change history of a service                      | `service_id`, `organization_id`, `action`, `actor_id`, `actor_role`, `changes` (`{ field: { before, after } }`)                                                                                                                                                                                                                                                                           |
| `news`               | Publications                                     | `organization_id`, `position`, `label`, `slug`, `rubric`, `enabled`, `date`, `publish_at`, `is_main`, `is_offer`, `expires_at`, `value`                                                                                                                                                                                                                                                   |
| `infosections`       | Static info blocks                               | `organization_id`, `position`, `label`, `enabled`, `control`, `value`                                                                                                                                                                                                                                                                                                                     |
| `images`             | Uploaded files                                   | `organization_id`, storage key, mime, size                                                                                                                                                                                                                                                                                                                                                |
| `archives`           | Snapshots of finished bookings                   | `organization_id`, `service_id`, `type`, `payload` (Mixed)                                                                                                                                                                                                                                                                                                                                |
| `bookings`           | One booking of one slot                          | `id` (public uuid), `service_id`, `organization_id`, `option_id`, `slot_id`, `slot_date`, `slot_time`, `starts_at`, `user_id`, `person`, `phone`, `info`, `fields`, `documents`, `status`, `active`, `confirmed_at`, `finished_at`, `reminder_sent_at`                                                                                                                                    |
| `waitlist`           | Clients waiting for a full slot                  | `id`, slot coordinates, `user_id`, `person`, `phone`, `status` (`waiting` \| `notified`), `notified_at`                                                                                                                                                                                                                                                                                   |
| `outbox_events`      | Transactional outbox                             | `id`, `type`, `organization_id`, `payload`, `internal`, `status`, `attempts`, `next_attempt_at`, `claimed_until`, `deliveries[]`                                                                                                                                                                                                                                                          |
| `webhooks`           | Subscriber URLs                                  | `organization_id` (`null` = platform-wide), `url`, `secret` (select: false), `events[]`, `enabled`, last outcome                                                                                                                                                                                                                                                                          |
| `users`              | Accounts                                         | `login`, `password_hash`, `phone`, `email`, `name`, `role`, `organization_ids[]`, `failed_login_attempts`, `last_failed_login_at`, `locked_until`                                                                                                                                                                                                                                         |
| `sessions`           | Refresh-token sessions                           | `user_id`, `family_id`, `refresh_token_hash`, `replaced_by`, `revoked_at`, `expires_at`                                                                                                                                                                                                                                                                                                   |
| `verification_codes` | One-time codes                                   | `phone`, `code_hash`, `attempts`, `consumed_at`, `expires_at`                                                                                                                                                                                                                                                                                                                             |
| `sms`                | Delivery log                                     | `phone`, `purpose`, `body`, `status`                                                                                                                                                                                                                                                                                                                                                      |
| `analytics_events`   | Business events (old `Statistics`)               | `type` + denormalised actor/organization/service labels                                                                                                                                                                                                                                                                                                                                   |
| `job_locks`          | Scheduler lease and last run                     | one document per job name; lease plus `last_status`, `last_error`, `last_duration_ms` ([jobs.md](jobs.md))                                                                                                                                                                                                                                                                                |
| `rate_limits`        | Throttler counters when `THROTTLE_STORAGE=mongo` | `key`, `count`, `expires_at`                                                                                                                                                                                                                                                                                                                                                              |
| `sms_counters`       | Global SMS budget windows                        | `_id` = `sms:<hour\|day>:<bucket>`, `count`, `expires_at`                                                                                                                                                                                                                                                                                                                                 |
| `idempotency_keys`   | Remembered writes per `Idempotency-Key`          | `scope`, `key`, `user_id`, `request_hash`, `status`, `response`, `expires_at`                                                                                                                                                                                                                                                                                                             |

## The service tree and its bookings

A service document carries its options; slots and bookings are collections of their own:

```
services
└─ options[]                 id, label, service_type, enabled, recurrent_dates[]

slots                        one document per slot
  service_id, organization_id, option_id, id, label, child_type,
  value
  ├─ date, description, link, price
  ├─ limit, booked_count                         (slot booked as a whole)
  └─ time[]                                      (slot booked per time)
     └─ time, limit, booked_count

bookings                     one document per booking
  id, service_id, organization_id, option_id, slot_id, slot_date, slot_time,
  user_id, person, phone, info, created_at
```

Responses still show the tree as `options[].slots[]`: the slots of a page of services are read in one query
and grafted in by `option_id`, in insertion (`_id`) order. A `fields=` list without `options` skips that
query.

Slots used to live inside `options[]` too. Every slot edit, every booking's counter update and every job
wrote the one service document, and the only way to change several slots at once was a `PATCH` with the
whole `options` array, which had to merge the stored counters back in by id. Now a slot is written on its own,
`PATCH /services/:id` refuses `options`, and a service stays small however many dates it carries.

Bookings used to live inside `options[].slots[]` **and** be mirrored in `users.bookings[]`. That put every
booking of a service into one 16 MB document, funnelled all of its write concurrency through that document,
made "the bookings of one user" a scan over a multikey path, and required a nightly job to reconcile the two
copies. Four things to know about the shape that replaced it:

- **Capacity is a counter, not a length.** `booked_count` stays on the slot so a booking can be accepted by
  one conditional update (`booked_count < limit`) in the same transaction as the insert. Never derive
  capacity from a count of booking documents.
- **Duplicates are an index, not a check.** `{ service_id, option_id, slot_id, slot_time, user_id }` is
  unique; a second identical booking fails the insert and surfaces as `409 BOOKING_ALREADY_EXISTS`.
- **Never rewrite a slot wholesale.** Jobs and the sub-resource routes use targeted `$push` / `$pull` /
  `$inc` on the exact path of one slot document, so a booking made concurrently with a job cannot be
  clobbered.
- **Bookings are also a resource of their own.** `GET /bookings`, `GET /me/bookings`,
  `GET /services/:id/bookings` and `DELETE /bookings/:id` read and write the collection directly, so a
  client no longer downloads a whole service document to see or cancel one booking.
- **The service document holds no personal data.** Bookings are read from their own collection and grafted
  into the response only for the organization's admins and super-admins; everyone else gets
  `{ "status": "reserved" }` markers rebuilt from `booked_count`, and a public route issues no booking query
  at all.
- **The tree carries cards, not services.** `GET /organizations/:id` projects every service down to
  `serviceCardSchema` inside the aggregation — the tile's fields plus `options_count` — so `options` and
  everything under it stay in the database. One tree is bounded by the number of services, not by how many
  slots they carry; the full service, its free capacity and its bookings each have their own route.

`users.password_hash`, `verification_codes.code_hash`, `sessions.refresh_token_hash` and `webhooks.secret` are
`select: false` — they are not even loaded unless a code path asks.

## The service as a catalogue entity (P3)

- **`status` is the source of truth**, `enabled` its shadow: every write sets `enabled = status === 'published'`,
  so the `{ organization_id, enabled, position }` index and `?enabled=` keep working, and a client that still
  sends `enabled: true` publishes. `published_at` is set on the first publication and never reset. The public
  sees published services only; an organization's admins also see their drafts, archive and trash.
- **`slug`** is unique per organization (partial unique index on `{ organization_id, slug }`), generated from
  the label by transliteration when not supplied, and served by `GET /organizations/:id/services/:slug`.
- **Soft delete.** `DELETE /services/:id` sets `deleted_at`; every read filters `deleted_at: null`, bookings stay
  untouched, `POST /services/:id/restore` brings it back, and `trash_purge` runs the real cascade after
  `SERVICE_TRASH_RETENTION_DAYS`. `?permanent=true` (super-admin) skips the trash. The scope resolver sees the
  trash on purpose, so restoring needs the same right as editing.
- **History.** Every write appends a `service_revisions` row with the actor and a diff of the top-level fields
  that changed; occupancy counters are stripped before comparing, because a booking is not an edit.
- **Working hours, duration and holidays** feed the recurrence: a `recurrent_dates` weekday with an empty `time`
  list is cut from the service's `working_hours` into `duration_minutes + buffer_minutes` steps, and dates in
  the service's `blackout_dates`, its `holidays` (`MM-DD`, yearly) or the organization's `holidays` are skipped.
- **`booking_policy`** — `max_active_per_user`, `lead_time_minutes`, `max_advance_days`,
  `cancel_deadline_minutes`, `requires_confirmation` — is enforced by the booking service for clients; the
  organization's admins are exempt from the client-facing rules.
- **Time zone.** A slot's `date` and `time` are wall clock in the owning organization's `timezone`, and every
  rule that compares them against "now" — lead time, the advance horizon, expiry, the recurrence walk,
  the debtor report — reads that zone, never the server's. A booking stores the resolved instant as
  `starts_at`, so the reminder window and the cancel deadline are one UTC comparison with no zone lookup, and
  `GET /services/:id/slots` renders it with the organization's offset.
- **`form_fields` and `required_documents`** describe what a booking must carry: answers arrive as `fields`
  (validated per type, unknown keys refused) and `documents` (keys the client confirms); both are stored on
  the booking row.

## Booking lifecycle (P3)

```
pending ──confirmed──▶ confirmed ──▶ completed ⇄ no_show
   │                       │
   └────── cancelled ◀─────┘
```

`active` is `true` for `pending` and `confirmed` and is what the partial unique index
`{ service_id, option_id, slot_id, slot_time, user_id }` keys on: a cancelled or finished row keeps its place in
the statistics without blocking the client from booking the slot again. Only active rows count against
capacity, appear in the default listings (`?status=all` lifts the filter) and are grafted into a service for
its admins. `finished_at` is set on every terminal status and carries the history TTL
(365 days). Deleting an account deletes its active bookings (capacity released) and
anonymises the finished ones — the outcome survives, the person does not.

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
- **Slots** — `{ service_id, option_id, id }` is unique and is also how a service's slots are read;
  `{ organization_id }` serves the organization cascade, and a partial `{ value.date }` over dated slots
  is the expiry job's scan.
- **Idempotency** — `idempotency_keys` is unique on `{ scope, user_id, key }`: claiming that key _is_ the
  atomic operation that makes a retried booking replay instead of running twice.
- **Catalogue** — `services` and `news` each carry one text index (`service_text`, `news_text`, weighted
  towards the label) behind `?q=`, a partial unique `{ organization_id, slug }`, and `services` adds
  `{ tags }`, `{ status, deleted_at }`, `{ deleted_at }` and a `2dsphere` on `location` for `/nearby`;
  `organizations` has `{ status }` and its own `2dsphere`; `news` has `{ rubric, date }` and `{ publish_at }`.
- **Lifecycle** — `bookings` adds `{ active, slot_date, reminder_sent_at }` (the reminder job's scan) and
  `{ organization_id, status, slot_date }` (statistics); `waitlist` is unique per slot and user and indexed by
  slot + status + `created_at` (first in line); `outbox_events` by `{ status, next_attempt_at }` (the claim);
  `webhooks` by `{ enabled, events }` (the fan-out); `service_revisions` by `{ service_id, created_at }`.
- **Uniqueness** — `users.login` and `users.phone` are unique with a partial filter on
  `{ $type: 'string' }`, so any number of accounts may have no login or no phone.
- **Partial** — `news.is_main` and `news.is_offer` are indexed only for the `true` documents.
- **Text** — `organizations.main_label` for search.
- **TTL** — `sessions.expires_at`, `verification_codes.expires_at`, `rate_limits.expires_at` (all
  `expireAfterSeconds: 0`), plus `sms_counters.expires_at` and `idempotency_keys.expires_at`; `archives.created_at` at
  30 days; `analytics_events.created_at` and `sms.created_at` at 365 days, because those rows carry client
  phone numbers and names; `bookings.finished_at` at 365 days (a live booking has no `finished_at`, so it never
  expires) and `outbox_events.created_at` at 30 days. Each window is a constant in the migration that creates
  the index.
  Deleting an account also strips `user_id`, `user_name` and `user_phone` from its analytics events, so the
  statistics survive the account without pointing at a person.

TTL windows live in the migration only, never in the schema, so development and production cannot drift.
