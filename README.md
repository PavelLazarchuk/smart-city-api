# Smart City API

NestJS 11 + TypeScript (strict) + MongoDB/Mongoose rewrite of the Smart City backend.
This file is the operational guide.
The rest of the documentation is indexed in [docs/README.md](docs/README.md).

## Stack

| Concern                    | Choice                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Runtime                    | Node 22 LTS (`.nvmrc`), npm only                                                                           |
| Framework                  | NestJS 11, Express 5                                                                                       |
| Database                   | MongoDB replica set (remote, or the local `local-db` Compose profile) via Mongoose 8                       |
| Validation / serialization | zod 4 — request **and** response schemas (`nestjs-zod` for pipes, DTOs and OpenAPI)                        |
| Auth                       | argon2id passwords, access + refresh JWT pair with rotation and reuse detection, hashed one-time SMS codes |
| Logging                    | pino (`nestjs-pino`), request id on every line and in every error response                                 |
| Jobs                       | `@nestjs/schedule` with a `job_locks` distributed lease                                                    |
| Migrations                 | `migrate-mongo` (indexes live in migrations; `autoIndex` is off in production)                             |
| Docs                       | Swagger UI at `/api/docs`, JSON at `/api/docs-json`                                                        |

## Getting started

```bash
cp .env.example .env   # fill in MONGO_URI and the two JWT secrets at minimum
npm ci
npm run migrate:up     # creates the indexes
npm run seed           # optional development data (super-admin: superadmin / Superadmin-Pass1)
npm run start:dev
```

The API listens on `PORT` (default 3000) under `API_PREFIX` (default `api/v1`):
`http://localhost:3000/api/v1/health/ready`, Swagger at `http://localhost:3000/api/docs`.

MongoDB is reached through `MONGO_URI` and must be a **replica set** — transactions are used for
every multi-document write. In development either point `MONGO_URI` at a remote replica set (Atlas or
self-managed) or start a local one:

```bash
docker compose --profile local-db up          # API + MailHog + a single-node replica set on :27017
```

The `local-db` profile is optional: `docker compose up` alone still starts only the API and MailHog
(inbox at `http://localhost:8025`). With the local database, set in `.env`

```
MONGO_URI=mongodb://localhost:27017/smart-city?directConnection=true   # API on the host
MONGO_URI=mongodb://mongo:27017/smart-city?directConnection=true       # API in Compose
```

The replica set is initiated automatically by the container healthcheck on first boot; data lives in
the `mongo-data` volume (`docker compose --profile local-db down -v` wipes it).

## Scripts

| Script                                                 | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `npm run start:dev` / `npm start`                      | watch mode / run `dist/main`                                   |
| `npm run build`                                        | `nest build` into `dist/`                                      |
| `npm run lint`, `npm run format`                       | ESLint 9 flat config, Prettier                                 |
| `npm run typecheck`                                    | `tsc --noEmit` over `src`, `test` and `scripts`                |
| `npm test`, `npm run test:cov`                         | Jest (unit + e2e projects); e2e boots an in-memory replica set |
| `npm run migrate:up` / `:down` / `:status` / `:create` | migrate-mongo against `MONGO_URI`                              |
| `npm run migrate:verify`                               | CI guard: `up` → `status` → `down` on an in-memory replica set |
| `npm run seed`                                         | development seed (idempotent; refuses `NODE_ENV=production`)   |

## Configuration

Every setting is an environment variable validated by a zod schema at boot
([src/common/config/env.schema.ts](src/common/config/env.schema.ts)); the process refuses to start
on a missing or malformed value. [.env.example](.env.example) lists every variable with placeholders.
Notable switches:

- `AUTH_ADMIN_LOGIN_METHOD` / `AUTH_CLIENT_LOGIN_METHOD` — `password` or `sms`, independently per audience.
- `SMS_PROVIDER` (`console` | `smpp`), `MAIL_PROVIDER` (`console` | `smtp`), `STORAGE_PROVIDER` (`local` | `s3`).
- `THROTTLE_STORAGE` (`mongo` | `redis` | `memory`) — Mongo and Redis are shared by every replica, `memory`
  is per process. `redis` needs `REDIS_URL` and keeps the counter writes off the database.
- `THROTTLE_LIMIT` / `THROTTLE_GLOBAL_LIMIT` / `THROTTLE_UPLOAD_LIMIT` — strict limit for `/auth/*` and per
  phone, soft per-IP ceiling for everything else, and the limit for image uploads.
- `SWAGGER_ENABLED` — defaults to on, except under `NODE_ENV=production` where it must be set explicitly.
- `JOBS_ENABLED` — whether _this_ process schedules jobs; mutual exclusion is the `job_locks` lease, not the flag.
- `METRICS_TOKEN` — bearer for `/metrics`. With none configured the route answers a super-admin token only;
  it never falls back to anonymous.
- `AUTH_FAILED_ATTEMPT_WINDOW_SECONDS` — how long a failed login keeps counting towards the per-account
  lock. The window is what stops the lock from being usable as a denial of service against one account.
- `PHONE_COUNTRY_CODE` — phone numbers are E.164 digits without `+` and must start with this code.
- `WEBHOOK_ALLOW_PRIVATE_HOSTS` — off by default: webhook targets on loopback or private networks are refused
  and production demands `https`.
- `SERVICE_TRASH_RETENTION_DAYS` — how long soft-deleted services are kept before `trash_purge` removes them.

Values that are part of the API contract or of how the service is built rather than of a deployment —
pagination limits, job schedules, outbox and upload ceilings, argon2 parameters, the Mongo write concern —
live in [src/common/config/constants.ts](src/common/config/constants.ts). TTL retention windows live in the
migration that creates the index, because changing one needs a `collMod` migration anyway.

> The old repository's `.env.example` and git history contain live credentials (Mongo Atlas, SMPP, SMTP,
> Mapbox). Rotate them before this service reaches production — see [docs/deployment.md](docs/deployment.md).

## API conventions

- Every data field is `snake_case` — JSON, query/path parameters, database fields, JWT claims.
- Envelope: `{ "data": … }` for single entities and lists, `{ "data": [...], "meta": { page, limit, total, total_pages, has_next, dropped } }` for pages,
  `{ "error": { code, message, details?, request_id } }` for failures. `meta.dropped` counts rows the response
  schema refused, so "end of page" and "row withheld" stay distinguishable.
- Status codes: 200 read/update, 201 create (with `Location`), 204 delete, 400 validation, 401 unauthenticated,
  403 unauthorised, 404 missing, 409 conflict, 422 business rule, 429 rate limit.
- Pagination: `page` (default 1, capped at 1000), `limit` (default 30, max 100), `sort`, `order`;
  `sms` and `analytics/events` also accept `cursor` and an explicit `mode=cursor|page` (they default to `cursor`).
  A cursor page leaves `total` and `total_pages` `null` unless `with_total=true` asks for the count.
- Reads return the complete entity; creates write only the entity; updates touch only the entity's own fields;
  deletes cascade inside a transaction.
- Bookings require a session; slots enforce capacity (`422 SLOT_FULL`); booking details are visible only to the
  organization's admins and super-admins, everyone else sees `{ "status": "reserved" }`. Bookings are stored
  in their own collection, so a service document carries occupancy counters and no personal data.
- Bookings are also a resource: `GET /bookings` (admins, filtered by organization, service, user, option,
  slot, `child_type` and `date_from`/`date_to`), `GET /me/bookings`, `GET /services/:id/bookings` and
  `DELETE /bookings/:id`, which needs no `service_id`.
- `POST /services/:id/bookings` accepts an `Idempotency-Key` header: a retry replays the original `201`
  (with `Idempotency-Replayed: true`) instead of answering `409 BOOKING_ALREADY_EXISTS`.
- `GET /services/:id/availability?from=&to=` is the cacheable, personal-data-free view of free capacity —
  no need to download the whole service to render a booking form.
- `GET /services/:id/slots` is the same capacity flattened to one row per bookable moment, each carrying
  `starts_at`/`ends_at` as ISO instants with the organization's offset, so a caller never rebuilds one from
  `date` + `time`. It filters server side (`after=`, `before=`, `option_id=`, `only_available=true`), drops
  times that have already passed, caps the list at `limit` (20 by default) and reports the uncapped `total`.
- Options and slots are sub-resources: `POST/PATCH/DELETE /services/:id/options[/:option_id]`,
  `POST/PATCH/DELETE /services/:id/options/:option_id/slots[/:slot_id]` and
  `PUT /services/:id/options/:option_id/recurrence` change one of them without resending the whole array.
  They are the only way to edit them: `PATCH /services/:id` answers `400 VALIDATION_ERROR` on `options`.
  `POST /services` still accepts the whole tree on creation.
- A slot also has two bulk admin operations, both in one transaction:
  `POST /services/:id/options/:option_id/slots/:slot_id/cancel` cancels every active booking of the slot, or of
  the one `time` given. With `remove` the slot (or that time) is deleted as well — the cabinet is closed, so its
  waiting list is dropped with it, since no place is freed. Without `remove` the capacity stays open and the
  freed places are offered to the waiting list exactly as an ordinary cancellation would.
  `POST /services/:id/options/:option_id/slots/:slot_id/move` moves the whole day to another `date`, optionally
  shifting every time by `shift_minutes`, carrying the bookings and the waiting list with it and clearing the
  reminder flag so the notice matches the new day. Both tell the affected clients by e-mail or SMS unless
  `notify: false`, take a `reason` that travels into the notice and the webhook payload, refuse to touch more
  than 500 rows at once, and accept an `Idempotency-Key` so a retried shift is replayed rather than applied
  twice.
- `GET /organizations/:id` returns the tree with every child list capped at 50 items. Services
  appear as cards — the fields a tile needs plus `options_count`, without `options`, so without slots or
  bookings; the full document comes from `GET /services/:id` or `GET /organizations/:id/services/:slug`,
  free capacity from `GET /services/:id/availability`, and the booking lists from `GET /services/:id` and
  `GET /organizations/:id/services`. `?fields=` trims the tree itself to the branches a screen renders.
- Services are a catalogue: `slug` (`GET /organizations/:id/services/:slug`), `status` draft/published/archived
  (`PUT /services/:id/status`; the public sees published only), `description`, `tags`, numeric `price` +
  `currency`, `address` + `location` (`GET /services/nearby?lat=&lng=&radius_m=`), `working_hours`, `holidays`,
  `blackout_dates`, `booking_policy`, `form_fields`, `required_documents`. Lists take `?q=` (full text),
  `?tags=`, `?include=organization,category`, `?facets=true` (value counts for `tags`, `categories` and
  `organizations` over the whole match, in `meta`) and `?fields=` (sparse fieldsets, `400 FIELDS_NOT_ALLOWED`
  for an unknown name). `?q=` goes to the text index first and retries the same words as a loose match on
  label, description and tags when it scores nothing, so a near-miss spelling still answers. `DELETE` is a soft delete (`?deleted=true` lists the trash, `POST /services/:id/restore`,
  `?permanent=true` for super-admins), and `GET /services/:id/history` is the change log.
- Bookings have a lifecycle: `pending → confirmed → completed | no_show`, or `cancelled`
  (`PATCH /bookings/:id/status`, admins); `GET /bookings/:id`; `POST /bookings/:id/confirm` is the owner's half
  of `requires_confirmation`, moving their own `pending` booking to `confirmed` without an admin;
  `POST /bookings/:id/reschedule` moves one in a single transaction; `GET /bookings/stats` gives no-show and cancellation rates; cancelled and finished rows
  stay as history (`?status=all|cancelled|…`, default `active`). A full slot has a waitlist
  (`POST /services/:id/waitlist`, `GET /me/waitlist`, `DELETE /waitlist/:id`): the first in line is told when a
  place frees up. Reminders go out `BOOKING_REMINDER_HOURS` before the slot.
- A client may keep an `email` on the account (at registration or later via `PATCH /users/:id`, `null` clears
  it). Reminders and freed-place notices then go to that address instead of by SMS; the letter names the phone
  the booking was made with, since one mailbox may serve several accounts.
- Notifications leave through a transactional outbox: the `subscribe` e-mail, reminders, freed-place notices and
  webhooks (`/webhooks`, HMAC-signed `POST`s for `booking.*` and `waitlist.*` events; `GET /outbox/events`,
  `POST /outbox/events/:id/replay`) are delivered after the commit with retries — see
  [docs/architecture.md](docs/architecture.md#outbox-and-webhooks).
- News have `slug` (`GET /organizations/:id/news/:slug`), `rubric` (`?rubric=`), `publish_at` (hidden from the
  public until then), `?q=` and an RSS 2.0 feed at `GET /news/rss?organization_id=&rubric=`, whose
  `<enclosure>` carries the type and size of the stored image, or the type its extension implies.
- Organizations carry `status` (`temporarily_closed` refuses new bookings), `working_hours`, `holidays`,
  `address` and `location` (`GET /organizations/nearby`).
- Every response carries the IETF `RateLimit-*` headers; the OpenAPI document lists every error code a route
  can answer with ([docs/errors.md](docs/errors.md#errors-in-the-openapi-document)).

The endpoint list with access rules is enforced by the authorization-matrix e2e suite; the live contract is the
Swagger document generated from the zod schemas.

## Project layout

```
src/
  main.ts, app.module.ts, app.setup.ts   bootstrap; app.setup is shared with the e2e harness
  common/        config, database (transaction runner, base repository), logging, metrics (/metrics),
                 http (errors, envelope), pagination, zod primitives, decorators, guards, cascade registry,
                 message catalogue
  modules/       auth, users, organizations, categories, services, bookings, news, infosections,
                 images, archives, sms, analytics, health, webhooks — each: controller / service / repository / schemas / dto
  integrations/  sms (console, smpp), mail (console, smtp), storage (local, s3) behind provider interfaces
  jobs/          recurrent slots, news expiry, slot expiry, stale bookings, cascade reconcile, storage gc,
                 debtor report, unreferenced images, outbox dispatch, booking reminders, trash purge;
                 job_locks lease carrying each job's last outcome
                 (what each one does and when: docs/jobs.md)
migrations/      migrate-mongo migrations (indexes)
scripts/         seed, migration verification
test/            e2e specs + fixtures (support/), unit specs live next to the code as *.spec.ts
docs/            architecture, auth, errors, data model, migrations, jobs, deployment notes
```

Layering rules: controllers never touch a model; services never touch `req`/`res`; repositories return lean
documents and accept an optional `ClientSession`; cross-module access goes through the other module's service.
Parent → child deletes are wired through the `CascadeRegistry`, so the module graph stays acyclic.

## License

Proprietary. Copyright (c) 2026 Pavel Lazarchuk. All rights reserved — see [LICENSE](LICENSE).
