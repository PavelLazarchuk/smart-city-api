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
([data-model.md](data-model.md)).

## Validation and serialization

zod is the single source of truth for both directions:
requests are parsed by `nestjs-zod`'s pipe, responses by the schema named in `@Serialize(...)`. A response
that does not match its schema is a `500 SERIALIZATION_ERROR` rather than a leak — this is what keeps
`password_hash`, `code_hash`, `value.subscribe` and booking details out of responses, and it is covered by
the sensitive-data e2e suite. The same schemas generate the OpenAPI document, so Swagger cannot drift from
the implementation.

## Providers

`integrations/` holds SMS (`console` | `smpp`), mail (`console` | `smtp`) and storage (`local` | `s3`) behind
interfaces chosen by environment variable. The console implementations are refused under
`NODE_ENV=production` (they would print one-time codes into the logs).
