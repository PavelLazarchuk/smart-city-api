# Errors

## Envelope

Every failure — validation, guard, business rule, crash — is rendered by
[`HttpExceptionFilter`](../src/common/http/http-exception.filter.ts) as:

```json
{
    "error": {
        "code": "SLOT_FULL",
        "message": "The slot is fully booked.",
        "details": [{ "path": "date", "message": "Required", "code": "invalid_type" }],
        "request_id": "01J8Z3K9P0QF7A2M4S6T8V0X"
    }
}
```

- `code` — stable, machine-readable, safe to switch on. Never changes for an existing condition.
- `message` — English text from the catalogue in [`messages.ts`](../src/common/i18n/messages.ts).
  All user-facing text lives there so localisation stays a data change; do not parse it.
- `details` — present for validation errors (one entry per zod issue) and where a rule names the
  offending fields. Absent otherwise.
- `request_id` — the same id that is on every log line for this request; pass `X-Request-Id` from the
  proxy to correlate end to end.

`5xx` never leaks an internal message or stack: the body is `INTERNAL_ERROR` and the detail goes to the log
(`error` level, with the stack). `4xx` is logged at `warn`.

## Raising an error

Application code throws [`ApiError`](../src/common/http/api-error.ts) and nothing else:

```ts
throw ApiError.unprocessable('SLOT_FULL');
throw ApiError.notFound('SERVICE_NOT_FOUND');
```

The status comes from the factory, the message from the catalogue keyed by the code. Adding a condition
means adding a key to `ERROR_CODES` **and** its text to `errorMessages` — the record type makes a missing
text a compile error.

## Status codes

| Status    | When                                                               |
| --------- | ------------------------------------------------------------------ |
| 400       | Malformed request: failed zod validation, bad file                 |
| 401       | Not authenticated, or the credential/token/code was rejected       |
| 403       | Authenticated but not allowed (role or organization scope)         |
| 404       | The entity does not exist, or the caller may not know that it does |
| 409       | Conflict with existing state (uniqueness, duplicate booking)       |
| 413 / 415 | Payload too large / unsupported media type                         |
| 422       | The request is well-formed but a business rule refuses it          |
| 429       | Rate limit                                                         |
| 500       | Unexpected failure, or a response that did not match its schema    |

A valid principal that lacks the role gets **403, not 401** — 401 means "authenticate", 403 means
"you did authenticate and it is still no".

## Code reference

### Generic

| Code                     | Status                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`       | 400                                                                                                                |
| `UNAUTHENTICATED`        | 401                                                                                                                |
| `FORBIDDEN`              | 403                                                                                                                |
| `NOT_FOUND`              | 404                                                                                                                |
| `CONFLICT`               | 409                                                                                                                |
| `PAYLOAD_TOO_LARGE`      | 413                                                                                                                |
| `UNSUPPORTED_MEDIA_TYPE` | 415                                                                                                                |
| `PAGE_OUT_OF_RANGE`      | 422 — `page` beyond `PAGINATION_MAX_PAGE`; narrow the query instead of paging deeper                               |
| `RATE_LIMITED`           | 429                                                                                                                |
| `INTERNAL_ERROR`         | 500                                                                                                                |
| `SERIALIZATION_ERROR`    | 500 — the response did not match its zod schema and was withheld                                                   |
| `DEPENDENCY_UNAVAILABLE` | 503 — `GET /health/deps` only; `details[]` names which dependencies are down, and the cause only for a super-admin |

### Authentication

| Code                              | Status | Meaning                                                                                           |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `INVALID_CREDENTIALS`             | 401    | Wrong identifier or password                                                                      |
| `TOKEN_INVALID` / `TOKEN_EXPIRED` | 401    | Access token rejected — refresh, then retry                                                       |
| `SESSION_REVOKED`                 | 401    | The session was revoked (logout-all, password change, account gone)                               |
| `REFRESH_TOKEN_REUSED`            | 401    | An already-rotated refresh token was presented; the whole token family is revoked — sign in again |
| `OTP_INVALID`                     | 401    | Wrong one-time code                                                                               |
| `OTP_EXPIRED`                     | 401    | Past `OTP_TTL_SECONDS`; request a new one                                                         |
| `OTP_ATTEMPTS_EXCEEDED`           | 401    | Beyond `OTP_MAX_ATTEMPTS`; request a new one                                                      |
| `LOGIN_METHOD_DISABLED`           | 403    | This audience signs in the other way (`AUTH_*_LOGIN_METHOD`)                                      |
| `PASSWORD_TOO_SHORT`              | 422    |                                                                                                   |
| `PASSWORD_UNCHANGED`              | 422    | The new password equals the current one                                                           |
| `LOGIN_TOO_SHORT`                 | 422    |                                                                                                   |
| `PHONE_COUNTRY_NOT_SUPPORTED`     | 422    | The number does not start with `PHONE_COUNTRY_CODE`                                               |

### Users

| Code                          | Status | Meaning                                                                 |
| ----------------------------- | ------ | ----------------------------------------------------------------------- |
| `USER_NOT_FOUND`              | 404    |                                                                         |
| `LOGIN_TAKEN` / `PHONE_TAKEN` | 409    | Uniqueness                                                              |
| `LAST_SUPER_ADMIN`            | 409    | The last super-admin cannot be deleted or demoted                       |
| `SELF_ROLE_CHANGE`            | 422    | Nobody changes their own role                                           |
| `ADMIN_PASSWORD_REQUIRED`     | 422    | Admins sign in by password, so the account needs a login and a password |
| `ADMIN_PHONE_REQUIRED`        | 422    | Admins sign in by code, so the account needs a phone                    |
| `CITIZEN_PHONE_REQUIRED`      | 422    | A citizen account needs a phone                                         |

### Content

| Code                                                                                                                                                   | Status | Meaning                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------- |
| `ORGANIZATION_NOT_FOUND`, `CATEGORY_NOT_FOUND`, `SERVICE_NOT_FOUND`, `NEWS_NOT_FOUND`, `INFOSECTION_NOT_FOUND`, `IMAGE_NOT_FOUND`, `ARCHIVE_NOT_FOUND` | 404    |                                              |
| `CATEGORY_ORGANIZATION_MISMATCH`                                                                                                                       | 422    | The category belongs to another organization |
| `ARCHIVE_SERVICE_MISMATCH`                                                                                                                             | 422    | The service belongs to another organization  |
| `REORDER_MISMATCH`                                                                                                                                     | 422    | A reorder must list every child exactly once |

### Bookings

| Code                                   | Status | Meaning                                                                                       |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `SLOT_NOT_FOUND` / `BOOKING_NOT_FOUND` | 404    |                                                                                               |
| `BOOKING_ALREADY_EXISTS`               | 409    | This citizen already booked this slot                                                         |
| `SLOT_NOT_BOOKABLE`                    | 422    | The slot type does not accept bookings                                                        |
| `OPTION_NOT_FOUND`                     | 404    | No option with this id on the service                                                         |
| `OPTION_HAS_BOOKINGS`                  | 409    | The option still holds bookings and cannot be removed                                         |
| `SLOT_HAS_BOOKINGS`                    | 409    | The slot still holds bookings and cannot be removed                                           |
| `SLOT_TIME_BOOKED`                     | 409    | A time entry that already holds bookings cannot be renamed or removed                         |
| `SLOT_NOT_DATED`                       | 422    | This slot type has no date                                                                    |
| `SLOT_NOT_LIMITED`                     | 422    | This slot type has no capacity limit                                                          |
| `SLOT_NOT_TIMED`                       | 422    | This slot type has no time entries                                                            |
| `SLOT_TIME_REQUIRED`                   | 422    | This slot needs a time, none was given                                                        |
| `SLOT_FULL`                            | 422    | Capacity reached — decided by a conditional update inside the transaction, so it is race-free |
| `SLOT_EXPIRED`                         | 422    | The slot date has passed                                                                      |
| `OPTION_DISABLED`                      | 422    | The service option is switched off                                                            |

### Files and delivery

| Code                                                       | Status |
| ---------------------------------------------------------- | ------ |
| `FILE_REQUIRED`, `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE` | 400    |
| `SMS_DELIVERY_FAILED`                                      | 422    |
| `SMS_BUDGET_EXCEEDED`                                      | 422    |

`FILE_TOO_LARGE` also covers multer's own limits: the upload is cut off at `UPLOAD_MAX_BYTES` while it is
still being read, so an oversized file is never buffered whole, and a type outside `UPLOAD_ALLOWED_MIME` is
refused with `FILE_TYPE_NOT_ALLOWED` before any of it is read.

### Declared but not currently raised

`LOGIN_IDENTIFIER_REQUIRED`, `ACCOUNT_HAS_NO_PASSWORD`, `ADMIN_IDENTIFIER_REQUIRED`,
`INCLUDE_NOT_ALLOWED`, `SERVICE_MODIFIED` exist in the catalogue but no code path
throws them today (the conditions are caught earlier, by zod or by a narrower code). They are kept because
clients may already switch on them; remove one only together with its text.
