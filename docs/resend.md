# Resend

Lightweight, dependency-free, in-memory Resend REST API fake for testing code that uses the real `resend` Node.js SDK (and the language-agnostic Resend REST API).

Default port: `4651`

## Quick start

Start the server:

```js
import { ResendServer } from "./services/resend/src/server.js";

const server = new ResendServer(4651);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `resend` client at it. The Resend SDK reads `baseUrl` from the options object, so override the base URL to the fake:

```js
import { Resend } from "resend";

const resend = new Resend("re_parlel_test_key", {
  baseUrl: "http://127.0.0.1:4651", // point at the parlel fake
});

const { data, error } = await resend.emails.send({
  from: "Acme <onboarding@resend.dev>",
  to: ["delivered@resend.dev"],
  subject: "hello world",
  html: "<p>it works!</p>",
});
// data.id => a generated UUID, error => null
```

Every send is captured in memory and can be inspected via the `/__parlel/*` endpoints (see below).

## Implemented operations

All routes require a `Authorization: Bearer <key>` header (any non-empty bearer token is accepted, matching how a local test key behaves). State is in-memory and ephemeral.

### Emails — the surface `resend.emails` and `resend.batch` call

- `POST /emails` — send an email (`resend.emails.send`). Validates the payload, captures it, returns `200 { id }`.
- `GET /emails/:id` — retrieve a sent email (`resend.emails.get`). Returns the documented `{ object: "email", id, to, from, created_at, subject, html, text, bcc, cc, reply_to, last_event, scheduled_at, tags }` shape.
- `PATCH /emails/:id` — update/reschedule a scheduled email (`resend.emails.update`). Returns `200 { object: "email", id }`.
- `POST /emails/:id/cancel` — cancel a scheduled email (`resend.emails.cancel`). Returns `200 { object: "email", id }`.
- `POST /emails/batch` — send up to 100 emails at once (`resend.batch.send`). Returns `200 { data: [{ id }, ...] }`. `attachments` and `scheduled_at` are rejected, matching the real API limitation.

Supports `Idempotency-Key` header on `POST /emails`: a repeated key replays the original response without creating a new email.

### Domains — `resend.domains`

- `POST /domains` — create a domain (`201`); returns DNS `records` (SPF MX, SPF TXT, three DKIM CNAMEs, and a Tracking CNAME), `status: "not_started"`, `region`, `capabilities`.
- `GET /domains` — list domains (`{ object: "list", data: [...] }`).
- `GET /domains/:id` — retrieve a domain.
- `PATCH /domains/:id` — update tracking/TLS settings.
- `POST /domains/:id/verify` — trigger verification (`status` → `pending`).
- `DELETE /domains/:id` — remove a domain.

### API keys — `resend.apiKeys`

- `POST /api-keys` — create a key (`201`); returns `{ id, object: "api_key", token }` (the token is only shown once, matching the real API response). A seeded default key always exists.
- `GET /api-keys` — list keys (`{ object: "list", data: [...] }`).
- `DELETE /api-keys/:id` — remove a key.

### Audiences — `resend.audiences`

- `POST /audiences` — create (`201 { object: "audience", id, name }`).
- `GET /audiences` — list.
- `GET /audiences/:id` — retrieve.
- `DELETE /audiences/:id` — remove (also clears its contacts).

### Contacts — `resend.contacts` (nested under an audience)

- `POST /audiences/:audienceId/contacts` — create (`201 { object: "contact", id }`). Custom `properties` are stored and echoed back on retrieve.
- `GET /audiences/:audienceId/contacts` — list (`{ object: "list", has_more, data: [...] }`).
- `GET /audiences/:audienceId/contacts/:idOrEmail` — retrieve by id **or** email. Returns the real contact shape `{ object: "contact", id, email, first_name, last_name, created_at, unsubscribed, properties }`.
- `PATCH /audiences/:audienceId/contacts/:idOrEmail` — update first/last name, unsubscribed.
- `DELETE /audiences/:audienceId/contacts/:idOrEmail` — remove.

### Broadcasts — `resend.broadcasts`

- `POST /broadcasts` — create (`201 { id }`). `send: true` sends immediately (`status: "sent"`); with `scheduled_at` it is queued. `scheduled_at` without `send: true` is rejected.
- `GET /broadcasts` — list.
- `GET /broadcasts/:id` — retrieve.
- `PATCH /broadcasts/:id` — update name/subject/from/html/text.
- `POST /broadcasts/:id/send` — send now, or schedule with `{ scheduled_at }`.
- `DELETE /broadcasts/:id` — remove (rejected if already sent).

### Service & inspection operations (parlel extensions, not part of Resend)

- `GET /` — service metadata (`{ name, version, protocol, documentation }`).
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/emails` — list every captured email with the full original request preserved under `_request` (`{ emails: [...], count }`).
- `GET /__parlel/emails/:id` — fetch one captured email (including `_request`).
- `DELETE /__parlel/emails` — clear only the captured mailbox, leaving other state intact.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `emails.send` / `get` / `update` / `cancel` | ✅ Supported |
| `batch.send` (≤100, no attachments/scheduling) | ✅ Supported |
| `domains.*` (create/list/get/update/verify/remove) | ✅ Supported |
| `apiKeys.*` (create/list/remove) | ✅ Supported |
| `audiences.*` (create/list/get/remove) | ✅ Supported |
| `contacts.*` (create/list/get/update/remove, by id or email) | ✅ Supported |
| `broadcasts.*` (create/list/get/update/send/remove) | ✅ Supported |
| `Idempotency-Key` replay on send | ✅ Supported |
| Error envelope `{ statusCode, name, message }` with correct status codes (`400`/`401`/`404`/`405`/`422`) | ✅ Supported |
| Payload validation (missing fields, invalid from/recipients, attachments, region, permission) | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| `created_at` exact wire format (space-separated microseconds) | ◐ Accepted — emitted as a valid ISO 8601 string |
| React component rendering (`react` field) | ◐ Accepted as content, not rendered |
| Contact custom `properties` | ◐ Accepted on create and echoed back on retrieve, not validated |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Bearer-token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) / quota enforcement | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| Real DNS verification of domains | ⟳ Roadmap — Intentionally unsupported (status flips to `pending` only) |
| Real idempotency-key 24h expiry | ⟳ Roadmap — Simplified (replayed until reset) |
| Segments / Topics / Templates / Webhooks / Logs REST resources | ⟳ Roadmap — Not part of the stable `resend` Node SDK surface audited |

## Error codes & shapes

Errors use the Resend envelope:

```json
{ "statusCode": 422, "name": "validation_error", "message": "..." }
```

| Status | `name` | When |
| --- | --- | --- |
| `400` | `invalid_idempotency_key` | `Idempotency-Key` longer than 256 chars |
| `400` | `validation_error` | malformed JSON body, invalid recipients, template+content conflict/absence, batch shape/limit, broadcast scheduling/delete rules |
| `401` | `missing_api_key` | no `Authorization: Bearer` header |
| `404` | `not_found` | unknown resource id or endpoint |
| `405` | `method_not_allowed` | method not allowed for the path |
| `422` | `missing_required_field` | required field (e.g. `from`, `to`, `subject`, `name`, `email`) missing |
| `422` | `invalid_from_address` | `from` not a valid `email@x` or `Name <email@x>` |
| `422` | `invalid_attachment` | attachment missing both `content` and `path` |
| `422` | `invalid_region` | domain region not one of `us-east-1`, `eu-west-1`, `sa-east-1`, `ap-northeast-1` |

| `500` | `application_error` | unexpected server error |

The generic `validation_error` returns **`400`** (matching the real API's errors
reference); only the *typed* errors above use `422`.

The official `resend` Node SDK does not throw on these; it resolves with `{ data: null, error: <envelope> }`.

## Manifest

See `services/resend/manifest.json`:

- name: `resend`, image: `parlel/resend:1.0`
- port: `4651`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `RESEND_API_KEY`, `RESEND_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
RESEND_API_KEY=re_parlel_test_key
RESEND_BASE_URL=http://localhost:4651
```

<!-- parlel:testenv:end -->
