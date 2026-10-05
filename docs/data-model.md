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

| Collection            | Owns                                                           | Key fields                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`       | The tenant                                                     | `main_label`, `main_category`, `main_image`, `status` (`active` \| `temporarily_closed`), `closed_reason`, `closed_until`, `address`, `location`, `working_hours[]`, `holidays[]`, `timezone`, `version`                                                                                                                                                                                  |
| `categories`          | Grouping inside an organization                                | `organization_id`, `position`, `label`, `enabled`                                                                                                                                                                                                                                                                                                                                         |
| `services`            | The bookable/"apply" unit                                      | `organization_id`, `category_id` (`null` = direct child), `position`, `label`, `slug`, `status`, `published_at`, `enabled`, `description`, `tags[]`, `duration_minutes`, `buffer_minutes`, `price`, `currency`, `address`, `location`, `working_hours[]`, `holidays[]`, `blackout_dates[]`, `booking_policy`, `form_fields[]`, `required_documents[]`, `value`, `options[]`, `deleted_at` |
| `slots`               | One slot of one service option                                 | `service_id`, `organization_id`, `option_id`, `id` (uuid, unique per option), `label`, `child_type`, `value` (`date`, `time[]`, `limit`, `booked_count`, …)                                                                                                                                                                                                                               |
| `service_revisions`   | Change history of a service                                    | `service_id`, `organization_id`, `action`, `actor_id`, `actor_role`, `changes` (`{ field: { before, after } }`)                                                                                                                                                                                                                                                                           |
| `news`                | Publications                                                   | `organization_id`, `position`, `label`, `slug`, `rubric`, `enabled`, `date`, `publish_at`, `is_main`, `is_offer`, `expires_at`, `value`                                                                                                                                                                                                                                                   |
| `infosections`        | Static info blocks                                             | `organization_id`, `position`, `label`, `enabled`, `control`, `value`                                                                                                                                                                                                                                                                                                                     |
| `images`              | Uploaded files                                                 | `organization_id`, storage key, mime, size                                                                                                                                                                                                                                                                                                                                                |
| `archives`            | Snapshots of finished bookings                                 | `organization_id`, `service_id`, `type`, `payload` (Mixed)                                                                                                                                                                                                                                                                                                                                |
| `bookings`            | One booking of one slot                                        | `id` (public uuid), `service_id`, `organization_id`, `option_id`, `slot_id`, `slot_date`, `slot_time`, `starts_at`, `user_id`, `person`, `phone`, `info`, `fields`, `documents`, `status`, `active`, `confirmed_at`, `finished_at`, `late_cancel`, `reminder_sent_at`, `created_by`                                                                                                       |
| `booking_suspensions` | No-show and manual suspensions, one row per client and service | `id`, `user_id`, `service_id`, `organization_id`, `suspended`, `until` (`null` = until lifted), `kind` (`no_show` \| `manual`), `reason`, `booking_ids[]`, `counted_from`, `suspended_at`/`_by`, `lifted_at`/`_by`                                                                                                                                                                        |
| `waitlist`            | Clients waiting for a full slot                                | `id`, slot coordinates, `user_id`, `person`, `phone`, `status` (`waiting` \| `notified`), `notified_at`                                                                                                                                                                                                                                                                                   |
| `outbox_events`       | Transactional outbox                                           | `id`, `type`, `organization_id`, `payload`, `internal`, `status`, `attempts`, `next_attempt_at`, `claimed_until`, `deliveries[]`, `request_id`, `trace`                                                                                                                                                                                                                                   |
| `webhooks`            | Subscriber URLs                                                | `organization_id` (`null` = platform-wide), `url`, `secret` (select: false), `events[]`, `enabled`, last outcome                                                                                                                                                                                                                                                                          |
| `channel_templates`   | An organization's own wording of an e-mail or SMS              | `organization_id`, `key`, `subject` (`null` for SMS), `body`, `updated_by`; unique per `{ organization_id, key }`                                                                                                                                                                                                                                                                         |
| `notifications`       | In-app notifications                                           | `id`, `audience` (`client` \| `staff`), `user_id` (`null` for staff), `organization_id`, `organization_label`, `type`, `status` (`unread` \| `read`), `read_at`, `title`, `body`, `data`, `subject_user_id`, `sender_id`, `message_id`, `source_event_id`                                                                                                                                 |
| `users`               | Accounts                                                       | `login`, `password_hash`, `phone`, `email`, `name`, `role`, `organization_ids[]`, `failed_login_attempts`, `last_failed_login_at`, `locked_until`, `calendar_token_hash`                                                                                                                                                                                                                  |
| `sessions`            | Refresh-token sessions                                         | `user_id`, `family_id`, `refresh_token_hash`, `replaced_by`, `revoked_at`, `expires_at`                                                                                                                                                                                                                                                                                                   |
| `verification_codes`  | One-time codes                                                 | `phone`, `code_hash`, `purpose`, `user_id`, `attempts`, `consumed_at`, `expires_at`                                                                                                                                                                                                                                                                                                       |
| `sms`                 | Delivery log                                                   | `phone`, `purpose`, `body`, `status`                                                                                                                                                                                                                                                                                                                                                      |
| `analytics_events`    | Business events                                                | `type` + denormalised actor/organization/service labels                                                                                                                                                                                                                                                                                                                                   |
| `job_locks`           | Scheduler lease and last run                                   | one document per job name; lease plus `last_status`, `last_error`, `last_duration_ms` ([jobs.md](jobs.md))                                                                                                                                                                                                                                                                                |
| `rate_limits`         | Throttler counters when `THROTTLE_STORAGE=mongo`               | `key`, `count`, `expires_at`                                                                                                                                                                                                                                                                                                                                                              |
| `sms_counters`        | Global SMS budget windows                                      | `_id` = `sms:<hour\|day>:<bucket>`, `count`, `expires_at`                                                                                                                                                                                                                                                                                                                                 |
| `idempotency_keys`    | Remembered writes per `Idempotency-Key`                        | `scope`, `key`, `user_id`, `request_hash`, `status`, `response`, `expires_at`                                                                                                                                                                                                                                                                                                             |
| `favorites`           | A client's saved services and organizations                    | `user_id`, `type` (`service` \| `organization`), `target_id`, `organization_id`                                                                                                                                                                                                                                                                                                           |
| `settings`            | Runtime settings overridden by a super admin                   | one document with the fixed `_id` `000000000000000000000001`: `settings` (overrides nested by group), `updated_at`                                                                                                                                                                                                                                                                        |

## The service tree and its bookings

A service document carries its options; slots and bookings are collections of their own:

```
services
└─ options[]                 id, label, service_type, enabled, recurrent_dates[], recurrent_ranges[]

slots                        one document per slot
  service_id, organization_id, option_id, id, label, child_type,
  value
  ├─ date, description, link, price
  ├─ limit, booked_count                         (slot booked as a whole)
  ├─ from, to, step_minutes, min_minutes,        (time_range: any interval on the grid)
  │  max_minutes, booked_count
  └─ time[]                                      (date_time and callback: booked per time)
     └─ time, to, limit, booked_count             (`to` only on a callback window)

bookings                     one document per booking
  id, service_id, organization_id, option_id, slot_id, slot_date, slot_time,
  slot_end, starts_at, ends_at, user_id, person, phone, info, address, created_at
```

Each option's `service_type` decides which `child_type`s its slots may have; anything else is refused with
`422 SLOT_TYPE_NOT_ALLOWED` on create, on adding a slot and on changing the option's type:

| `service_type`     | Slot types                                             | Meaning                                                            |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `service_apply`    | `date_time`, `date`, `apply`, `time_range`, `callback` | Appointments, applications, rentals and call-back requests         |
| `service_payment`  | `paycard`                                              | Payment details (description, link, price); not bookable           |
| `service_delivery` | `pickup`, `courier`                                    | How the result is handed over; information only, not bookable      |
| `service_visit`    | `time_range`, `date_time`                              | A specialist comes to the client; every booking needs an `address` |

A `time_range` slot is one resource (a court, a hall, a specialist): four courts are four slots. A booking picks
`time`–`end_time` on the `step_minutes` grid from `from`, between `min_minutes` and `max_minutes` long, and is
refused with `SLOT_FULL` when it comes closer than the service's `buffer_minutes` to another active booking of
the slot. There is no limit to compare against, so the guard is a query, and two concurrent requests would
both see a free interval; each one therefore also bumps the slot's `booked_count`, which makes the second
transaction hit a write conflict, retry, and then see the first booking. The overlap query runs on the partial
`unique_booking_per_slot` index. Without `from`/`to` the slot takes the day's span from `working_hours`; the
step defaults to `duration_minutes`, then 30. The waitlist is not offered for it.

An option whose type allows `time_range` can also carry `recurrent_ranges`: per weekday, the named
`resources` (courts, halls, specialists), an optional `from`/`to` (otherwise the weekday's span from
`working_hours`) and the step and duration limits. The `recurrent_slots` job keeps one `time_range` slot per
resource and date over the horizon; such a slot carries `value.resource` and is labelled with it. A slot
without `resource` was made by hand and the job never touches it. The same `resource` may appear only once per
weekday.

A `callback` slot is a list of windows (`time`–`to`) with a limit each; its booking needs a phone, and the
reminder goes to the service's `subscribe` address as `booking.callback_due` instead of to the client.

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

`users.password_hash`, `users.calendar_token_hash`, `verification_codes.code_hash`, `sessions.refresh_token_hash`
and `webhooks.secret` are `select: false` — they are not even loaded unless a code path asks.

`organizations.version` is raised by every write to the organization or to anything its tree shows, and is what
the tree's `ETag` is built from ([architecture.md](architecture.md#conditional-reads)). `bookings.created_by` is
the account that made the booking — the client, or the admin who booked `on_behalf` of them.
`favorites.organization_id` is the organization of the target, so deleting an organization removes its services'
entries in one statement.

## The service as a catalogue entity

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
  `cancel_deadline_minutes`, `late_cancel`, `requires_confirmation` — is enforced by the booking service for
  clients; the organization's admins are exempt from the client-facing rules. `late_cancel` decides what a
  client's cancellation inside `cancel_deadline_minutes` does: `forbid` (the default) refuses it, `no_show`
  lets it through until the booking starts, marks it `late_cancel: true` and counts it as a no-show (see
  below). Once the booking has started, and for a late reschedule, the answer is the 422 either way.
- **Time zone.** A slot's `date` and `time` are wall clock in the owning organization's `timezone`, and every
  rule that compares them against "now" — lead time, the advance horizon, expiry, the recurrence walk,
  the debtor report — reads that zone, never the server's. A booking stores the resolved instant as
  `starts_at`, so the reminder window and the cancel deadline are one UTC comparison with no zone lookup, and
  `GET /services/:id/slots` renders it with the organization's offset.
- **`form_fields` and `required_documents`** describe what a booking must carry: answers arrive as `fields`
  (validated per type, unknown keys refused) and `documents` (keys the client confirms); both are stored on
  the booking row.

## Booking lifecycle

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

## No-show sanctions

`booking_policy.no_show_limit`, `no_show_window_days` and `no_show_suspension_days` switch them on for a
service (limit and length are set together; no window counts every no-show). A `no_show` mark counts the
client's no-shows of that service with `finished_at` inside the window and after `counted_from`; reaching the
limit suspends the client for `no_show_suspension_days`, records the counted bookings in `booking_ids` and
moves `counted_from` to now, so the next suspension needs a fresh set of no-shows. Correcting one of those
bookings back to `completed` lifts the suspension, and so does `DELETE /suspensions/:id`; both restart the
count as well. A manual suspension (`POST /suspensions`, by `user_id` or `phone`, `days` optional) needs no
no-shows. Reaching the limit while a manual suspension is in force only extends its `until`: the kind, the
reason and who set it stay, so correcting a no-show never lifts a manual suspension. Suspending a client also
removes them from the service's waitlists, so a freed place is offered to someone who can book it.

Under `late_cancel: no_show` a client's late cancellation counts the same way: the booking ends `cancelled`
with `late_cancel: true` (the place is freed and the waitlist told), and the counter takes it alongside the
`no_show` marks. A cancelled booking cannot be corrected, so staff lift such a suspension with
`DELETE /suspensions/:id`. The `booking.cancelled` event carries `late_cancel: true`.

The row is per client and service and every counted mark writes to it before counting, so two marks for the
same client in concurrent transactions conflict on it and the retried one sees the other's no-show. Expiry is
a comparison with `until` at read time — no job clears it. A suspended client gets `422 BOOKING_SUSPENDED` on
booking and on joining a waitlist; a reschedule, existing bookings and staff booking `on_behalf` are untouched.

## Channel templates

The client and staff e-mails and SMS that belong to an organization — booking created, reminder, freed place,
cancellation, move, suspension, call-back due; twelve keys in all, one per event and channel — are rendered
from templates. The built-in wording lives in `texts.channels` in
[messages.ts](../src/common/i18n/messages.ts); a row in `channel_templates` replaces it for one
organization and one key, and deleting the row brings the built-in text back. One-time codes, the SMS test
message and the super-admin reports have no organization and keep their fixed text.

A template is plain text with `{{variable}}`, `{{#variable}}…{{/variable}}` (rendered when the value is
present) and `{{^variable}}…{{/variable}}` (rendered when it is not); sections nest, and a line holding only a
section tag disappears with its line break. Each key has its own variable list
([channel-catalogue.ts](../src/modules/channel-templates/channel-catalogue.ts)), and a template
naming anything else, or with an unbalanced section, is refused on save with `400 VALIDATION_ERROR`. The
template is applied when the outbox delivers the event, not when it is queued, so an edit also changes notices
still waiting in the outbox. Should a stored template stop rendering after a catalogue change, or come out empty
for one event (a body of only `{{reason}}` and no reason given), delivery falls back to the built-in text and
logs a warning instead of failing.

## Runtime settings

Part of the configuration is editable at runtime by a super admin through `/settings`: login methods, the
account lock, token and one-time code lifetimes, rate limits, SMS limits, upload limits, the booking reminder
lead, retention horizons, the default currency and the report recipients. The keys, their schemas and
descriptions live in [settings.registry.ts](../src/common/settings/settings.registry.ts); a key that is not
there can be neither read nor written.

The whole application shares one document in `settings`:

```
{
  _id: ObjectId("000000000000000000000001"),
  settings: { auth: { admin_login_method: "sms", lockout_seconds: 600 }, upload: { allowed_mime: ["image/png"] } },
  updated_at: Date
}
```

`settings` holds only the overridden keys, nested by group, so the key `auth.lockout_seconds` is the path
`settings.auth.lockout_seconds`. A write sets or unsets only the keys it changes
(`$set: { "settings.auth.lockout_seconds": 600 }`, and `$unset` of the whole group once it is empty), so every
other key is left as it is. A missing key falls back to the
environment variable and then to the default in `env.schema.ts`. Every instance keeps the values in memory and
reads `updated_at` every 10 seconds, rereading the document when it moved. A stored value that no longer passes
its schema, or a path the registry no longer knows, is ignored with a warning but kept in the document: another
instance may run a newer version or a higher `UPLOAD_MAX_BYTES` and still use it. Writing or resetting that key
replaces or removes it; a group that is not an object at all is replaced by the next write to it.

`updated_at` doubles as the ETag: `GET /settings` returns it, and a `PATCH` or `DELETE` sent with `If-Match`
answers `409 SETTINGS_CONFLICT` when someone else wrote in between. The write itself is one `updateOne`
conditioned on the `updated_at` it validated against, so two concurrent writes cannot both pass.

## Notifications

The in-app feed of `GET /me/notifications`. A row is either a **client** notification — `user_id` is the
account it belongs to — or a **staff** notification, which belongs to an organization (`user_id: null`) and is
shared by every `operator` and `common-admin` of it: one read status for all of them, so whoever opens it marks
it read for the desk. Each row carries its organization, the rendered `title` and `body` (from `texts.inbox` in
[messages.ts](../src/common/i18n/messages.ts), at the time it was created) and `type` + `data`, so a client may
show the text as it is or build its own. The `organization.label` in a response is read from the organization
at request time; `organization_label` is the fallback when the organization is gone.

Rows about events are written by the outbox handler `handler:inbox`
([notification-dispatcher.service.ts](../src/modules/notifications/notification-dispatcher.service.ts)) from the
rules in [notification-rules.ts](../src/modules/notifications/notification-rules.ts): a client hears what the
staff or the system did to their booking (cancellation, declined request, confirmation, move, a booking made for
them, a closed or moved slot — always, whatever `notify` said, since `notify` is about SMS and e-mail — a
reminder, a freed place, a suspension and its lifting); the staff hear what clients did (booked, cancelled,
moved), call-backs falling due and suspensions the system imposed for no-shows. Nobody is told about their own
action, and a staff member does not see staff rows about their own bookings. `source_event_id` is unique per
audience, so a retried or replayed event writes nothing twice. `POST /organizations/:id/messages` writes an
`organization_message` straight to one client (`sender_id` is kept for audit and never returned).

A client sees their own rows from every organization; a staff member sees the staff rows of the organizations
currently in their `organization_ids`, checked on every request, so leaving an organization hides its rows at
once. A user keeps at most 30 read rows of their own and an organization 30 read staff rows
(`NOTIFICATIONS.keepRead`; the oldest go when something is marked read), and at most 400 unread
(`NOTIFICATIONS.maxUnread`; the oldest go when a new one arrives). Everything expires 30 days after creation.
Deleting an account removes its rows and the staff rows about it; deleting an organization removes all of its rows.

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
  `{ user_id, starts_at }` serves the calendar feed;
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
  `organizations` has `{ status }` and its own `2dsphere`; `news` has `{ rubric, date }`, `{ publish_at }` and
  `{ organization_id, publish_at }` (the tree's tag).
- **Lifecycle** — `bookings` adds `{ active, slot_date, reminder_sent_at }` (the reminder job's scan) and
  `{ organization_id, status, slot_date }` (statistics); `waitlist` is unique per slot and user and indexed by
  slot + status + `created_at` (first in line); `outbox_events` by `{ status, next_attempt_at }` (the claim);
  `webhooks` by `{ enabled, events }` (the fan-out); `service_revisions` by `{ service_id, created_at }`;
  `booking_suspensions` is unique on `{ user_id, service_id }` and indexed by `{ service_id }` (cascade) and
  `{ organization_id, suspended_at }` (the staff listing).
- **Uniqueness** — `users.login`, `users.phone` and `users.calendar_token_hash` are unique with a partial filter
  on `{ $type: 'string' }`, so any number of accounts may have no login, no phone or no calendar token.
- **Favorites** — `{ user_id, type, target_id }` is unique (adding twice is a no-op), `{ user_id, created_at }`
  serves the list, `{ target_id }` and `{ organization_id }` the two cascades.
- **Outbox tracing** — a partial `{ request_id }` behind `GET /outbox/events?request_id=`.
- **Notifications** — `{ user_id, status, created_at, _id }` and `{ organization_id, audience, status, created_at, _id }`
  serve the feed, the counter and the trimming (and the second one the organization cascade); a unique partial
  `{ source_event_id, audience }` keeps one row per event; `{ subject_user_id }` over staff rows is the account
  cascade.
- **Partial** — `news.is_main` and `news.is_offer` are indexed only for the `true` documents.
- **Text** — `organizations.main_label` for search.
- **TTL** — `sessions.expires_at`, `verification_codes.expires_at`, `rate_limits.expires_at` (all
  `expireAfterSeconds: 0`), plus `sms_counters.expires_at` and `idempotency_keys.expires_at`; `archives.created_at` at
  30 days; `analytics_events.created_at` and `sms.created_at` at 365 days, because those rows carry client
  phone numbers and names; `bookings.finished_at` at 365 days (a live booking has no `finished_at`, so it never
  expires) and `outbox_events.created_at` at 30 days; `notifications.created_at` at 30 days. Each window is a constant in the migration that creates
  the index.
  Deleting an account also strips `user_id`, `user_name` and `user_phone` from its analytics events, so the
  statistics survive the account without pointing at a person.

TTL windows live in the migration only, never in the schema, so development and production cannot drift.
