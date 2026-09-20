# Architecture

## Request lifecycle

```
HTTP → helmet / CORS → pino request logger (assigns request_id)
     → ThrottlerGuard            (per IP, per phone, per upload — THROTTLE_* settings)
     → JwtAuthGuard              (optional-aware: attaches the principal when a token is present)
     → RolesGuard                (@Roles → 403 when the role does not match)
     → OrganizationScopeGuard    (@OrganizationScope → a common-admin only inside their organizations)
     → ZodValidationPipe         (request body / query / params)
     → Controller → Service → Repository → Mongoose
     ← ResponseInterceptor       (envelope + response zod schema from @Serialize)
     ← HttpExceptionFilter       (ApiError / anything else → { error: { code, message, details?, request_id } })
```

Everything the process needs is validated once at boot by
[env.schema.ts](../src/common/config/env.schema.ts); a missing or malformed variable stops the start.
`configureApp()` in [app.setup.ts](../src/app.setup.ts) wires all of the above and is shared by `main.ts`
and the e2e harness, so tests exercise the real pipeline.

## Layers

| Layer      | May do                                                                                  | Must not do                                |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| Controller | Declare route, roles, scope, request/response schemas; call one service method          | Touch a model, build queries, shape errors |
| Service    | Business rules, transactions, cross-module calls through the other module's **service** | Touch `req`/`res`, know about HTTP verbs   |
| Repository | Mongoose queries; returns lean documents; accepts an optional `ClientSession`           | Contain business rules                     |

Cross-module reads go through the owning module's service — never another module's repository or model.

## Keeping the module graph acyclic

A parent cannot import its children (organization → category → service …), because the children already
import the parent. Two registries invert those dependencies:

- **[`CascadeRegistry`](../src/common/cascade/cascade.registry.ts)** — a child module registers, at boot,
  what must be deleted when a parent goes away (`organization` | `category` | `service` | `user`). The
  parent's delete runs every hook inside its own transaction and never imports a child.
  Registered hooks are asserted by an e2e guard, so a new child that forgets to register fails the build.
- **[`ScopeResolverRegistry`](../src/common/guards/scope-resolver.registry.ts)** — a module registers how to
  find the organization behind one of its entities, so `OrganizationScopeGuard` can authorise
  `PATCH /services/:id` without importing the services module.

## Transactions and after-commit effects

Every multi-document write goes through [`TransactionRunner`](../src/common/database/transaction-runner.ts),
which opens a session, retries on transient errors, and gives the callback a `TransactionContext`. Side
effects that must not happen twice and must not happen at all on a rollback — sending an SMS, an e-mail, an
analytics event — are registered with `ctx.afterCommit(...)` and fire once the transaction has committed.
This is why MongoDB must be a replica set in every environment, development included — locally
the `local-db` Compose profile provides a single-node one.

Booking capacity is enforced by a conditional update inside the transaction (`booked_count < limit`), not by
a read-then-write; the loser gets `422 SLOT_FULL`. The booking itself is a document in `bookings`,
inserted in the same transaction, and a duplicate is refused by a unique index rather than by a prior read
([data-model.md](data-model.md)). A client that retries a booking over a flaky network sends
`Idempotency-Key`: the key is claimed in `idempotency_keys` before the transaction runs, so the retry gets
the original `201` back (with `Idempotency-Replayed: true`) instead of a `409` that says nothing about
whether the first attempt landed.

## Outbox and webhooks

A business write and the record of "something happened" commit together: the booking service inserts an
`outbox_events` row in the same transaction as the booking (`booking.created`, `booking.cancelled`,
`booking.rescheduled`, `booking.status_changed`; the reminder job adds `booking.reminder`, a freed place
`waitlist.slot_available`). After the commit the caller pokes
[`OutboxService`](../src/common/outbox/outbox.service.ts), which claims due events with a short lease and fans
each one out to its targets: the internal handlers registered for the type (the `subscribe` e-mail, the
reminder and the freed-place notice) and every enabled webhook subscribed to it — the organization's own hooks
plus the platform-wide ones a super-admin created. `booking.reminder` and `waitlist.slot_available` each have
two handlers, `mail` and `sms`, which read the recipient captured in the event's `internal`: the mail one sends
when the account has an `email`, the SMS one only when it has none, so exactly one channel is used per event
and a mail failure is retried as mail rather than turning into an SMS. Every target is retried on its own with
exponential backoff up to `OUTBOX_MAX_ATTEMPTS`; an event is `failed` only once the budget is spent, and
`POST /outbox/events/:id/replay` puts it back. The `outbox_dispatch` job is the safety net for retries and for
a replica that died between commit and poke.

What a subscriber receives is the `payload` — coordinates, status, ids — never the person: names, phone numbers
and the notification address travel in the event's `internal` field, which only handlers read. A webhook call
is `POST` with `X-Webhook-Id`, `X-Webhook-Event`, `X-Webhook-Timestamp` and
`X-Webhook-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`; the secret is shown once, on creation or
rotation. Because the platform makes these requests on an admin's behalf, the URL is checked against loopback,
link-local and private ranges when it is saved and again — after DNS resolution — when it is called, redirects
are not followed, and production demands `https` (`WEBHOOK_ALLOW_PRIVATE_HOSTS` lifts both for development).

## Validation and serialization

zod is the single source of truth for both directions:
requests are parsed by `nestjs-zod`'s pipe, responses by the schema named in `@Serialize(...)`. A response
that does not match its schema is a `500 SERIALIZATION_ERROR` rather than a leak — this is what keeps
`password_hash`, `code_hash`, `value.subscribe` and booking details out of responses, and it is covered by
the sensitive-data e2e suite. Routes that serve two audiences declare both schemas with `@SerializeBy(...)`
and the narrow one is used for the public audience: a service page for a citizen is serialized by a schema
that accepts occupancy markers only, so a forgotten mask cannot leak a name or a phone number. In a list a
row the schema refuses is dropped rather than failing the page, and the count is reported — `meta.dropped`
in the response, `response_items_dropped_total` in the metrics. A handler marked `@SparseFields()` accepts
`?fields=a,b` and trims every serialized row to those keys (plus `id`), refusing a name the schema does not have
with `400 FIELDS_NOT_ALLOWED`. The same schemas generate the OpenAPI document, so Swagger cannot drift from
the implementation, and the error responses are generated too ([errors.md](errors.md#errors-in-the-openapi-document)).

## Providers

`integrations/` holds SMS (`console` | `smpp`), mail (`console` | `smtp`) and storage (`local` | `s3`) behind
interfaces chosen by environment variable. The console implementations are refused under
`NODE_ENV=production` (they would print one-time codes into the logs).
