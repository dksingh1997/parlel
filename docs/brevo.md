# Brevo

Lightweight, dependency-free, in-memory Brevo (formerly Sendinblue) API v3 fake for testing code that uses the real `@getbrevo/brevo` SDK (or the language-agnostic Brevo REST API).

Default port: `4828`

## Quick start

Start the server:

```js
import { BrevoServer } from "./services/brevo/src/server.js";

const server = new BrevoServer(4828);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@getbrevo/brevo` client at it (override basePath / send `api-key`):

```js
await fetch("http://127.0.0.1:4828/v3/smtp/email", {
  method: "POST",
  headers: { "api-key": "xkeysib-parlel", "Content-Type": "application/json" },
  body: JSON.stringify({
    sender: { email: "sender@parlel.dev", name: "Parlel" },
    to: [{ email: "recipient@parlel.dev" }],
    subject: "Hello",
    htmlContent: "<b>Hi</b>",
  }),
});
// => { messageId: "<...@parlel.brevo>" }
```

Every send is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4828`. Use `BREVO_BASE_URL` to point
clients/agents at it. Captured mail lives at `GET /__parlel/messages`.

## Implemented operations

All `/v3/*` routes require the `api-key` header. State is in-memory and ephemeral.

- `POST /v3/smtp/email` — send a transactional email (`sender, to, subject, htmlContent`). Captures and returns `{ messageId }`.
- `GET /v3/contacts` — list contacts (`{ contacts, count }`).
- `POST /v3/contacts` — create a contact (`email` required); returns `{ id }`.
- `GET /v3/contacts/:identifier` — get a contact by email or id.
- `PUT /v3/contacts/:identifier` — update a contact (`204`).
- `DELETE /v3/contacts/:identifier` — delete a contact (`204`).
- `POST /v3/smtp/templates` — create a template; returns `{ id }`.
- `GET /v3/account` — account info.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured messages (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured message.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `sendTransacEmail` (`POST /v3/smtp/email`) | ✅ Supported |
| Contacts CRUD (create/list/get/update/delete) | ✅ Supported |
| Template creation | ✅ Supported |
| Account info | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Real template rendering | ◐ Accepted; not rendered |
| Lists / folders / campaigns / webhooks / stats | ⟳ Roadmap |
| Real API-key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the Brevo envelope `{ "code": "...", "message": "..." }`.

| Status | `code` | When |
| --- | --- | --- |
| `401` | `unauthorized` | missing/empty `api-key` |
| `400` | `missing_parameter` | required `sender`/`to`/`templateName` missing |
| `400` | `invalid_parameter` | invalid email or malformed body |
| `400` | `duplicate_parameter` | contact already exists |
| `404` | `document_not_found` | unknown contact |

## Manifest

See `services/brevo/manifest.json`:

- name: `brevo`, image: `parlel/brevo:1.0`
- port: `4828`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `BREVO_API_KEY`, `BREVO_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
BREVO_API_KEY=xkeysib-parlel
BREVO_BASE_URL=http://localhost:4828
```

<!-- parlel:testenv:end -->
