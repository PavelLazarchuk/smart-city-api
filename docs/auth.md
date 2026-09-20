# Authentication and authorization

## Roles

| Role           | Who                | Scope                                                         |
| -------------- | ------------------ | ------------------------------------------------------------- |
| `common-user`  | Citizen            | Own profile and own bookings                                  |
| `common-admin` | Organization admin | Only organizations listed in the account's `organization_ids` |
| `super-admin`  | Platform operator  | Everything; bypasses the organization scope check             |

Two rules protect the platform from lock-out and privilege drift: the last `super-admin` cannot be deleted
or demoted (`409 LAST_SUPER_ADMIN`), and nobody may change their own role (`422 SELF_ROLE_CHANGE`).

## Login methods

Each audience has its own deployment-time method, `password` or `sms`:

- `AUTH_ADMIN_LOGIN_METHOD` — default `password`
- `AUTH_CITIZEN_LOGIN_METHOD` — default `sms`

An account created for an audience must carry what that method needs (`ADMIN_PASSWORD_REQUIRED`,
`ADMIN_PHONE_REQUIRED`, `CITIZEN_PHONE_REQUIRED`), and using the wrong door answers
`LOGIN_METHOD_DISABLED`. Flipping a method on a live system is not a supported migration — see
[deployment.md](deployment.md).

Passwords are argon2id (`ARGON2_MEMORY_COST` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM`) and the hash lives
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
uses it. `PATCH /users/:id` changes it later, `"email": null` clears it. When it is set, booking reminders and
freed-place notices go to it instead of by SMS.

## Endpoints

| Endpoint                                           | Purpose                                       |
| -------------------------------------------------- | --------------------------------------------- |
| `POST /auth/login`                                 | Password login (login or phone as identifier) |
| `POST /auth/register`                              | Citizen self-registration                     |
| `POST /auth/otp/request` / `POST /auth/otp/verify` | One-time code login                           |
| `POST /auth/refresh`                               | Rotate the token pair                         |
| `POST /auth/logout` / `POST /auth/logout-all`      | Revoke this session / every other session     |
| `GET /auth/me`                                     | The current principal                         |
| `GET /auth/sessions`                               | The account's own devices                     |
| `DELETE /auth/sessions/:sid`                       | Sign one device out                           |
| `PATCH /auth/password`                             | Change own password                           |

## How a route is authorised

```ts
@Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
@OrganizationScope({ from: 'entity', entity: 'service' })
@Patch(':id')
```

`RolesGuard` answers `403 FORBIDDEN` (not 401) when a valid principal lacks the role.
`OrganizationScopeGuard` resolves the organization behind the request — from a path/body parameter or by
loading the entity through the `ScopeResolverRegistry` — and lets a `common-admin` through only when it is in
their `organization_ids`; a super-admin always passes, a citizen never does. The role is decided **before**
anything is loaded, so a super-admin pays no extra read and a citizen is refused without one; an admin of
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

Every response says where the caller stands: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
(seconds) and `RateLimit-Policy` (`<limit>;w=<window seconds>`) describe the window with the least headroom
among those that applied — on `/auth/*` the strict one — and a `429` carries `Retry-After`. The legacy
`X-RateLimit-*-<name>` headers per throttler are still sent.

## Webhooks

`POST/GET/PATCH/DELETE /webhooks` are for admins: a `common-admin` manages the hooks of their own organizations
(`organization_id` required), a `super-admin` any of them and the platform-wide ones (`organization_id: null`),
which receive every organization's events. `GET /outbox/events` and `POST /outbox/events/:id/replay` follow the
same scope. The secret appears in exactly two responses: creation and `POST /webhooks/:id/rotate-secret`.
