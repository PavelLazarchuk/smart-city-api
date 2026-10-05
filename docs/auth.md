# Authentication and authorization

## Roles

| Role           | Who                | Scope                                                         |
| -------------- | ------------------ | ------------------------------------------------------------- |
| `common-user`  | Client             | Own profile and own bookings                                  |
| `common-admin` | Organization admin | Only organizations listed in the account's `organization_ids` |
| `operator`     | Front desk         | Same organization scope as `common-admin`, narrower rights    |
| `super-admin`  | Platform operator  | Everything; bypasses the organization scope check             |

An `operator` works the bookings of their organizations — lists, statistics, status changes, reschedules,
cancellations, booking `on_behalf`, waitlists, suspensions, cancelling or moving a whole slot (but not
`remove: true`, which deletes it) — and manages news, their order and image uploads. Everything else that
changes the catalogue (services, options, slots, recurrence, categories, info sections, the organization,
image deletion) stays with `common-admin`, as do webhooks, the outbox, channel templates and archives. For reading, an operator
sees what a `common-admin` of the same organization sees: booking details, drafts and scheduled news. Routes
name their roles through the groups in
[roles.decorator.ts](../src/common/decorators/roles.decorator.ts) — `ADMIN_ROLES`, `STAFF_ROLES`,
`ORGANIZATION_ROLES` — and a role missing from a route's list is refused, so a new role starts with no access.
Operators sign in like admins (`AUTH_ADMIN_LOGIN_METHOD`) and only a super-admin creates them.

`/me/notifications` is open to every signed-in account and only ever shows the caller's own rows, plus — for an
`operator` or `common-admin` — the shared staff rows of the organizations in their current `organization_ids`.
Writing to a client (`POST /organizations/:id/messages`) and the client list behind it
(`GET /organizations/:id/clients`) are `STAFF_ROLES` within the organization scope; the client sees the
organization as the sender, never the staff member.

Two rules protect the platform from lock-out and privilege drift: the last `super-admin` cannot be deleted
or demoted (`409 LAST_SUPER_ADMIN`), and nobody may change their own role (`422 SELF_ROLE_CHANGE`).

## Login methods

Each audience has its own method, `password` or `sms`, set by the environment and changeable at runtime by a
super admin through `PATCH /settings` (no restart; the other instances follow within 10 seconds):

- `auth.admin_login_method` — `AUTH_ADMIN_LOGIN_METHOD`, default `password`
- `auth.client_login_method` — `AUTH_CLIENT_LOGIN_METHOD`, default `sms`

A switch of the staff method that would lock out the super admins is refused with `409 SETTING_LOCKOUT_RISK`:
to `sms` the acting super admin needs a phone, and so does at least one other super admin if there are any; to
`password` the acting super admin needs a login and a password. Other staff members left without the needed
identifier do not block the switch; the response lists them under `warnings`. While staff sign in by SMS, the
same `409` refuses an `sms.hourly_limit` or `sms.daily_limit` (lowered, or set where there was none) that the
messages already sent in the current hour or day have used up, and a switch to `sms` while either budget is
spent: sign-in codes share the budget with every other SMS, so nobody could receive one until the window ends.
Raising a limit or setting it to `0` is always accepted. The account lock, token and
one-time code lifetimes and the rate limits below are runtime settings as well
([data-model.md](data-model.md#runtime-settings)); new values apply to tokens and codes issued afterwards.

An account created for an audience must carry what that method needs (`ADMIN_PASSWORD_REQUIRED`,
`ADMIN_PHONE_REQUIRED`, `CLIENT_PHONE_REQUIRED`), and using the wrong door answers
`LOGIN_METHOD_DISABLED`. Flipping a method on a live system is not a supported migration — see
[deployment.md](deployment.md).

Passwords are argon2id (parameters in [constants.ts](../src/common/config/constants.ts)) and the hash lives
in a `select: false` field, so it is not even loaded unless a code path asks for it.

### Password policy

Every path that sets a password — registration, `POST /users`, `PATCH /users/:id`, `PATCH /auth/password` —
requires 8–20 characters with at least one
lowercase latin letter, one uppercase latin letter, one digit and one special (non-alphanumeric) character.
A refusal is `422 PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG` / `PASSWORD_TOO_WEAK`, and `details[]` lists
every requirement that failed at once, so a form can show them all instead of one per attempt.

## One-time codes

`POST /auth/otp/request` issues a CSPRNG code of `OTP_LENGTH` digits, stores **only its argon2 hash** in
`verification_codes` with `OTP_TTL_SECONDS`, and hands the plaintext to the SMS provider. Requesting a code
for a phone that has no account still costs the same work (a dummy hash is computed) so the endpoint does not
reveal who is registered.

`POST /auth/otp/verify` fails with `OTP_EXPIRED` past the TTL, counts attempts and fails with
`OTP_ATTEMPTS_EXCEEDED` beyond `OTP_MAX_ATTEMPTS`, and consumes the record atomically — a code works once.
The record is removed by a TTL index on `expires_at`.

Every code carries a `purpose`: `login` for the two endpoints above, `phone_change` for the profile flow below,
which also binds the code to the requesting account. A code of one purpose is never accepted by the other, and
the attempt budget carries over per phone and purpose.

## Own profile

`PATCH /me` changes the caller's `name`, `email` (`null` clears it) and `phone`. A new phone is a sign-in
identifier, so it needs proof of ownership: `POST /me/phone/code` with `{ "phone" }` sends a `phone_change` code
to the new number, and `PATCH /me` with `{ "phone", "code" }` applies it. Without a code the answer is
`422 PHONE_CODE_REQUIRED`, a wrong, expired, foreign or exhausted code is `422 PHONE_CODE_INVALID` (not a `401`,
so a client does not mistake it for a dead session). A number another account already uses gets no SMS but the
same answer and the same argon2 cost, so the endpoint does not enumerate accounts; the change then fails on the
code. A successful change revokes every other session of the account and drops the codes of the old number.
`POST /me/phone/code` sits under the strict `THROTTLE_LIMIT` like `/auth/*`, and `PATCH /me` with a `phone`
under the per-phone limit.

## Tokens and sessions

A successful login returns an access/refresh pair:

- **Access token** — JWT, `JWT_ACCESS_TTL` (default 5 min), carries `sub`, `role`, `organization_ids`, `sid`.
  Sent as `Authorization: Bearer …`.
- **Refresh token** — JWT, `JWT_REFRESH_TTL` (default 7 days). Only its **hash** is stored, in a
  `select: false` field of the `sessions` document.

Every token carries `iss` (`JWT_ISSUER`), `aud` (`JWT_AUDIENCE`) and a `kid` header, and verification
demands all three: a staging token is refused in production even if the two share a secret. **Rotating a
secret** does not sign anyone out — publish the new `JWT_ACCESS_SECRET` with a new `JWT_ACCESS_KID`, keep
the old one in `JWT_ACCESS_PREVIOUS_KEYS` as `kid:secret` while its tokens are still alive, then drop that
entry. `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must differ, or the app refuses to boot: one secret for
both would make a refresh token a valid access token.

`POST /auth/refresh` rotates in a single transaction: the presented session is marked `replaced_by` and a new
session is written with the same `family_id`. Presenting a token that was already rotated or revoked is
**reuse detection** — the entire `family_id` is revoked at once and the caller gets
`401 REFRESH_TOKEN_REUSED`. `POST /auth/logout` revokes the current session, `POST /auth/logout-all` revokes
every other session of the account and keeps the caller's. Expired sessions disappear through a TTL index.

`GET /auth/sessions` lists the account's own live sessions — id, user agent, ip, `expires_at` and `current`
for the one making the request — and `DELETE /auth/sessions/:sid` signs one device out. Another account's
session id answers `404 SESSION_NOT_FOUND`; refresh-token hashes never leave the database.

Changing a password takes `current_password` (required for accounts that have one), `new_password` and
`new_password_confirmation`, which must repeat `new_password` exactly, and revokes the account's other
sessions.

Both `POST /auth/register` and `POST /auth/otp/verify` take an optional `email`. It is stored on the account
as a contact address, never as a login identifier: it is not unique, it is not verified, and no sign-in method
uses it. `PATCH /me` (or `PATCH /users/:id`) changes it later, `"email": null` clears it. When it is set, booking reminders and
freed-place notices go to it instead of by SMS.

## Endpoints

| Endpoint                                           | Purpose                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `POST /auth/login`                                 | Password login (login or phone as identifier)  |
| `POST /auth/register`                              | Client self-registration                       |
| `POST /auth/otp/request` / `POST /auth/otp/verify` | One-time code login                            |
| `POST /auth/refresh`                               | Rotate the token pair                          |
| `POST /auth/logout` / `POST /auth/logout-all`      | Revoke this session / every other session      |
| `GET /auth/me`                                     | The current principal                          |
| `GET /auth/sessions`                               | The account's own devices                      |
| `DELETE /auth/sessions/:sid`                       | Sign one device out                            |
| `PATCH /auth/password`                             | Change own password                            |
| `PATCH /me`                                        | Change own name, e-mail or (with a code) phone |
| `POST /me/phone/code`                              | Send a code to the new phone                   |

## How a route is authorised

```ts
@Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
@OrganizationScope({ from: 'entity', entity: 'service' })
@Patch(':id')
```

`RolesGuard` answers `403 FORBIDDEN` (not 401) when a valid principal lacks the role.
`OrganizationScopeGuard` resolves the organization behind the request — from a path/body parameter or by
loading the entity through the `ScopeResolverRegistry` — and lets a `common-admin` through only when it is in
their `organization_ids`; a super-admin always passes, a client never does. The role is decided **before**
anything is loaded, so a super-admin pays no extra read and a client is refused without one; an admin of
another organization gets the same `404` as for an id that does not exist (`403` only where the
organization comes from the request body, because then there is no resource to hide). Routes that are readable by
anyone still run the JWT guard in optional mode, because the response is masked by role: booking details are
visible only to the organization's admins and super-admins, everyone else sees `{ "status": "reserved" }`.

The full endpoint-by-endpoint access matrix is enforced by the authorization-matrix e2e suite.

## Rate limiting

`/auth/*` and per-phone actions use the strict `THROTTLE_LIMIT`; everything else the soft per-IP
`THROTTLE_GLOBAL_LIMIT`; uploads `THROTTLE_UPLOAD_LIMIT`. With `THROTTLE_STORAGE=mongo` (the default) the
counters live in the `rate_limits` collection and are therefore shared by every replica. Set
`TRUST_PROXY=true` behind a reverse proxy, or every request will be counted against the proxy's IP.

`THROTTLE_STORAGE=redis` (with `REDIS_URL`) keeps the same limits but moves the counters to Redis, where one
`INCR` replaces a Mongo write per request — the option to pick once traffic is heavy enough that throttling
would otherwise compete with real queries for database throughput. Each key is a single `INCR` plus a
`PEXPIRE` inside one Lua script, so simultaneous requests share a window instead of each opening a fresh one,
and keys expire on their own. If Redis is unreachable the request is let through and the outage is logged
once: a protective layer must not take the API down with it, so capacity limits belong in front of the
application (a WAF or `limit_req`) rather than here.

Every response says where the caller stands: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
(seconds) and `RateLimit-Policy` (`<limit>;w=<window seconds>`) describe the window with the least headroom
among those that applied — on `/auth/*` the strict one — and a `429` carries `Retry-After`. The legacy
`X-RateLimit-*-<name>` headers per throttler are still sent.

## Webhooks

`POST/GET/PATCH/DELETE /webhooks` are for admins: a `common-admin` manages the hooks of their own organizations
(`organization_id` required), a `super-admin` any of them and the platform-wide ones (`organization_id: null`),
which receive every organization's events. `GET /outbox/events` and `POST /outbox/events/:id/replay` follow the
same scope. The secret appears in exactly two responses: creation and `POST /webhooks/:id/rotate-secret`.
