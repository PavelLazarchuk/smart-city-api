# Deployment notes

## Prerequisites

- A MongoDB **replica set** (Atlas or self-managed). Transactions are used for every multi-document write.
  The `local-db` Compose profile runs `mongo:8.2`; 8.0 refuses to start on Linux kernels 6.19 and newer
  (`MongoDB cannot start: … known incompatibility`, [SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)),
  which recent Docker Desktop VMs already run, and no 8.0 patch release carries the fix yet. The e2e suite is
  unaffected — it runs `mongodb-memory-server` — so this surfaces only when starting the local database.
- Node 22 LTS or the provided multi-stage `Dockerfile` (non-root user, healthcheck on `/api/v1/health/live`).
- TLS terminates at the reverse proxy (nginx); the app serves plain HTTP on `PORT`. Set `TRUST_PROXY=true`
  behind a proxy so client IPs (rate limiting, session records) are correct.

## Rotate the leaked credentials first

The previous repository committed real secrets in `.env.example` and they remain in its git history:
the Mongo Atlas password, the SMPP password, the SMTP password and a Mapbox key. Rotate all four
before this service is exposed; nothing in this repository contains or depends on the old values.

## Release steps

1. `npm ci && npm run build`
2. `npm run migrate:up` against the target database (idempotent; run before starting the new version).
   The bookings migration is the one that is **not** backwards compatible: it removes the embedded booking
   arrays, so stop the old replicas before running it — see [migrations.md](migrations.md).
3. Start the API replicas with `JOBS_ENABLED=false`.
4. Start exactly one worker process with `JOBS_ENABLED=true` (or let several run — the `job_locks` lease guarantees
   single execution per tick; the flag only decides who _schedules_).
5. Check `GET /api/v1/health/ready` (Mongo only — what the load balancer should poll),
   `GET /api/v1/health/deps` (Mongo, object storage and SMTP) and `GET /api/v1/health/info` for the version
   and commit actually deployed.

## Environment

See `.env.example`. Minimum for production: `NODE_ENV=production`, `MONGO_URI`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET` (32+ characters each, different values), `CORS_ORIGINS`, provider settings
(`SMS_PROVIDER=smpp` + `SMPP_*`, `MAIL_PROVIDER=smtp` + `SMTP_*`, `STORAGE_PROVIDER` + its settings),
`REPORT_RECIPIENTS`, `JOBS_TIMEZONE`, and `METRICS_TOKEN` unless `METRICS_ENABLED=false`.

The console providers are **refused** under `NODE_ENV=production`: `ConsoleSmsProvider` writes the message
body — which carries the one-time code — to the log, so a production process that fell back to the default
would both stop delivering codes and publish them. The boot fails with a message naming the variable.

`SWAGGER_ENABLED` has no default in production either: the document describes the whole API surface, so it
stays off unless the variable is set explicitly. Everywhere else it defaults to on.

Rate limiting applies to every route, not only `/auth/*`: `THROTTLE_GLOBAL_LIMIT` is the soft per-IP ceiling
for the public read surface, `THROTTLE_LIMIT` the strict one for `/auth/*` and per phone number,
`THROTTLE_UPLOAD_LIMIT` the one for image uploads. `THROTTLE_STORAGE=mongo` (the default) shares the counters
across replicas; `memory` is per process.

`PAGINATION_MAX_PAGE` caps offset pagination depth — a request beyond it is answered with
`422 PAGE_OUT_OF_RANGE` instead of an unbounded `$skip`.

`autoIndex` is off in production; indexes exist only if migrations ran. TTL retention lives in the migrations
alone (the Mongoose schemas do not declare it, so dev and production cannot drift apart): changing
`ARCHIVE_RETENTION_DAYS`, `ANALYTICS_RETENTION_DAYS` or `SMS_RETENTION_DAYS` requires a new migration that
runs `collMod` on the respective TTL index (`expireAfterSeconds`). `analytics_events` and `sms` expire on
`created_at` because those rows carry citizen phone numbers and names.

The Mongo connection is pinned by `MONGO_MAX_POOL_SIZE`, `MONGO_MIN_POOL_SIZE`,
`MONGO_SERVER_SELECTION_TIMEOUT_MS`, `MONGO_SOCKET_TIMEOUT_MS`, `MONGO_RETRY_WRITES`,
`MONGO_WRITE_CONCERN` and `MONGO_READ_PREFERENCE` rather than by whatever the URI happens to carry, so a
copied connection string cannot quietly change the durability of every write.

`SMS_HOURLY_LIMIT` and `SMS_DAILY_LIMIT` cap outgoing messages across every sender and replica: past the
cap a send is refused with `422 SMS_BUDGET_EXCEEDED`, the attempt is logged in `sms` with status `blocked`,
and `sms_budget_blocked_total` rises — alert on it, because it means either an attack or an undersized
budget. `AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_SECONDS` and `AUTH_LOCKOUT_MAX_SECONDS` govern the
per-account lock that catches one login being guessed from many addresses, and
`AUTH_FAILED_ATTEMPT_WINDOW_SECONDS` is how long a failure keeps counting towards it. That window is what
keeps the lock from becoming a weapon: the count is a sliding window, not a running total, so an attacker
cannot hold a known account shut indefinitely by spending one wrong password per lock period. Raising it
above `AUTH_LOCKOUT_MAX_SECONDS` buys nothing; below `AUTH_LOCKOUT_SECONDS` the schema refuses it, because
the counter would then reset while the account is still locked and the escalation could never happen.

## Token claims: a one-time re-login on this release

Verification now demands `iss` and `aud`, and tokens issued by the previous version carry neither, so every
access and refresh token in flight stops working the moment the new version serves traffic: everyone signs in
again once. Plan the release accordingly (it is the only such step — later **key** rotations keep sessions,
see [auth.md](auth.md)). To avoid it entirely, deploy in two steps: first a release that signs with the claims
but does not require them, then one that requires them, `JWT_REFRESH_TTL` later.

## Login-method switches

`AUTH_ADMIN_LOGIN_METHOD` and `AUTH_CITIZEN_LOGIN_METHOD` are deployment-time choices. Flipping the citizen
method on a live system leaves `sms` citizens without a password or `password` citizens with an unverified
phone; that migration flow (set password by OTP / verify phone) is out of scope.

## Observability

Logs are JSON (pino). Every line and every error response carries `request_id`; pass `X-Request-Id` from the
proxy to correlate. Secrets, tokens, codes and phone numbers are redacted.

`GET /api/v1/metrics` serves the Prometheus text format and is excluded from the OpenAPI document. It is
authorised by `METRICS_TOKEN` as a bearer (a super-admin access token works too) and refuses the scrape
without it; production boots only with a token set or `METRICS_ENABLED=false`. An environment that simply
forgot the variable does **not** fall back to anonymous access — with no token configured only a
super-admin token is accepted, so a staging or QA instance never publishes the registry to the internet.
Keep the route off the public listener as well — the token is a second line of defence, not the first.

`GET /api/v1/health/deps` stays public for uptime probes, but a failing dependency is reported to an
anonymous caller as `down` and nothing more: a driver's message names the SMTP host and port or the bucket
it could not reach. The cause is in the log, and in the same response when a super-admin asks with a token.
`GET /api/v1/health/jobs` (super-admin) reports how each scheduled job last ended — see
[jobs.md](jobs.md).

What is exported, beyond the default process and Node metrics:

| Metric                                                           | Use                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `http_request_duration_seconds{method,route,status}`             | Latency and traffic per route pattern                   |
| `http_request_errors_total{method,route,status_class}`           | 4xx / 5xx rate                                          |
| `job_runs_total{job,result}`, `job_duration_seconds{job}`        | "The job did not run" is now a query, not a missing log |
| `db_transactions_total{result}`, `db_transaction_attempts_total` | Retry ratio: attempts over committed                    |
| `sms_messages_total{provider,purpose,status}`                    | Spend and delivery failures                             |
| `sms_budget_blocked_total{window}`                               | The budget cap was hit                                  |
| `response_items_dropped_total{route}`                            | List rows the response schema refused — schema drift    |

Route labels are patterns (`/api/v1/services/:id`), never URLs, so the label set stays bounded.
