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
cp .env.example .env      # fill in MONGO_URI and the two JWT secrets at minimum
npm ci
npm run migrate:up        # creates the indexes
npm run seed              # optional development data (super-admin: superadmin / superadmin-password)
                          # idempotent: re-running it adds neither accounts nor content
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

| Script                            | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `npm run start:dev` / `npm start` | watch mode / run `dist/main`                                   |
| `npm run build`                   | `nest build` into `dist/`                                      |
| `npm run lint`, `npm run format`  | ESLint 9 flat config, Prettier                                 |
| `npm run typecheck`               | `tsc --noEmit` over `src`, `test` and `scripts`                |
| `npm test`, `npm run test:cov`    | Jest (unit + e2e projects); e2e boots an in-memory replica set |
| `npm run migrate:up               | down                                                           | status | create` | migrate-mongo against `MONGO_URI` |
| `npm run migrate:verify`          | CI guard: `up` → `status` → `down` on an in-memory replica set |
| `npm run seed`                    | development seed (idempotent; refuses `NODE_ENV=production`)   |

## Configuration

Every setting is an environment variable validated by a zod schema at boot
([src/common/config/env.schema.ts](src/common/config/env.schema.ts)); the process refuses to start
on a missing or malformed value. [.env.example](.env.example) lists every variable with placeholders.
Notable switches:

- `AUTH_ADMIN_LOGIN_METHOD` / `AUTH_CITIZEN_LOGIN_METHOD` — `password` or `sms`, independently per audience.
- `SMS_PROVIDER` (`console` | `smpp`), `MAIL_PROVIDER` (`console` | `smtp`), `STORAGE_PROVIDER` (`local` | `s3`).
- `THROTTLE_STORAGE` (`mongo` | `memory`) — the Mongo storage is shared by every replica.
- `THROTTLE_LIMIT` / `THROTTLE_GLOBAL_LIMIT` / `THROTTLE_UPLOAD_LIMIT` — strict limit for `/auth/*` and per
  phone, soft per-IP ceiling for everything else, and the limit for image uploads.
- `PAGINATION_MAX_PAGE` — depth ceiling for offset pagination (`422 PAGE_OUT_OF_RANGE` beyond it).
- `SWAGGER_ENABLED` — defaults to on, except under `NODE_ENV=production` where it must be set explicitly.
- `ARCHIVE_RETENTION_DAYS` / `ANALYTICS_RETENTION_DAYS` — TTL of archived snapshots and analytics events;
  the value is applied by the migration, not by the schema (see [docs/deployment.md](docs/deployment.md)).
- `JOBS_ENABLED` — whether _this_ process schedules jobs; mutual exclusion is the `job_locks` lease, not the flag.
- `PHONE_COUNTRY_CODE` — phone numbers are E.164 digits without `+` and must start with this code.

> The old repository's `.env.example` and git history contain live credentials (Mongo Atlas, SMPP, SMTP,
> Mapbox). Rotate them before this service reaches production — see [docs/deployment.md](docs/deployment.md).

## API conventions

- Every data field is `snake_case` — JSON, query/path parameters, database fields, JWT claims.
- Envelope: `{ "data": … }` for single entities and lists, `{ "data": [...], "meta": { page, limit, total, total_pages, has_next } }` for pages,
  `{ "error": { code, message, details?, request_id } }` for failures.
- Status codes: 200 read/update, 201 create (with `Location`), 204 delete, 400 validation, 401 unauthenticated,
  403 unauthorised, 404 missing, 409 conflict, 422 business rule, 429 rate limit.
- Pagination: `page` (default 1, capped by `PAGINATION_MAX_PAGE`), `limit` (default 30, max 100), `sort`, `order`;
  `sms` and `analytics/events` also accept `cursor` and an explicit `mode=cursor|page` (they default to `cursor`).
- Reads return the complete entity; creates write only the entity; updates touch only the entity's own fields;
  deletes cascade inside a transaction.
- Bookings require a session; slots enforce capacity (`422 SLOT_FULL`); booking details are visible only to the
  organization's admins and super-admins, everyone else sees `{ "status": "reserved" }`.
- `GET /organizations/:id` returns the tree with every child list capped at `INCLUDE_MAX_ITEMS` and with
  anonymised bookings for every audience; the full booking lists come from `GET /services/:id` and
  `GET /organizations/:id/services`.

The endpoint list with access rules is enforced by the authorization-matrix e2e suite; the live contract is the
Swagger document generated from the zod schemas.

## Project layout

```
src/
  main.ts, app.module.ts, app.setup.ts   bootstrap; app.setup is shared with the e2e harness
  common/        config, database (transaction runner, base repository), logging, http (errors, envelope),
                 pagination, zod primitives, decorators, guards, cascade registry, message catalogue
  modules/       auth, users, organizations, categories, services (+bookings), news, infosections,
                 images, archives, sms, analytics, health — each: controller / service / repository / schemas / dto
  integrations/  sms (console, smpp), mail (console, smtp), storage (local, s3) behind provider interfaces
  jobs/          recurrent slots, news expiry, slot expiry, stale bookings, debtor report; job_locks lease
                 (what each one does and when: docs/jobs.md)
migrations/      migrate-mongo migrations (indexes)
scripts/         seed, migration verification
test/            e2e specs + fixtures (support/), unit specs live next to the code as *.spec.ts
docs/            ADRs, deployment notes, scheduled jobs
```

Layering rules: controllers never touch a model; services never touch `req`/`res`; repositories return lean
documents and accept an optional `ClientSession`; cross-module access goes through the other module's service.
Parent → child deletes are wired through the `CascadeRegistry`, so the module graph stays acyclic.

## License

Proprietary. Copyright (c) 2026 Pavel Lazarchuk. All rights reserved — see [LICENSE](LICENSE).
