# Mailgun

Lightweight, dependency-free, in-memory Mailgun API v3 fake for testing code that uses the real `mailgun.js` SDK (or the language-agnostic Mailgun REST API).

Default port: `4826`

## Quick start

Start the server:

```js
import { MailgunServer } from "./services/mailgun/src/server.js";

const server = new MailgunServer(4826);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `mailgun.js` client at it:

```js
import formData from "form-data";
import Mailgun from "mailgun.js";

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: "api",
  key: "key-parlel",
  url: "http://127.0.0.1:4826", // point at the parlel fake
});

const result = await mg.messages.create("sandbox.parlel", {
  from: "Excited User <mailgun@sandbox.parlel>",
  to: ["user@parlel.dev"],
  subject: "Hello",
  text: "Testing some Mailgun awesomeness!",
});
// result => { id: "<...@sandbox.parlel>", message: "Queued. Thank you." }
```

Messages are POSTed as `application/x-www-form-urlencoded` (or `multipart/form-data`) form fields. Every send is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL is exposed at `http://127.0.0.1:4826`. Use `MAILGUN_BASE_URL`
to point clients/agents at it. Captured mail is available at
`GET /__parlel/messages` for assertions without ever delivering real email.

## Implemented operations

All `/v3/*` and `/v4/*` routes require HTTP Basic auth (`Authorization: Basic base64("api:key-...")`, exactly what `mailgun.js` sends). State is in-memory and ephemeral. Routes/shapes match the official `mailgun.js` SDK (`mg.messages`, `mg.events`, `mg.lists`, `mg.domains`).

- `POST /v3/:domain/messages` — send a message (`mg.messages.create`). Parses `from,to,subject,text,html` form fields from `multipart/form-data` (what the SDK sends) or `application/x-www-form-urlencoded`, captures the message, returns `{ id, message: "Queued. Thank you." }`. Multiple `to=` values collapse into an array.
- `GET /v3/:domain/events` — list delivery events (`mg.events.get`; one `accepted` event is recorded per send). `paging` values are absolute URLs so the SDK's `new URL(pageUrl)` parsing never throws.
- `GET /v3/lists/pages` (and `GET /v3/lists`) — list mailing lists (`mg.lists.list`). Returns `{ items, paging }` with absolute paging URLs.
- `POST /v3/lists` — create a mailing list (`mg.lists.create`, `address` required). Returns `{ message, list }`; the `list` carries `address, name, description, access_level, reply_preference, members_count, created_at`.
- `GET /v3/lists/:address` — fetch one mailing list (`mg.lists.get`), returns `{ list }`.
- `PUT /v3/lists/:address` — update a mailing list (`mg.lists.update`), returns `{ message, list }`.
- `DELETE /v3/lists/:address` — delete a mailing list (`mg.lists.destroy`), returns `{ address, message }`.
- `GET /v4/domains` — list domains (`mg.domains.list`; a seeded `sandbox.parlel` always exists). Returns `{ total_count, items }`.

Legacy aliases (kept working for older callers): `GET /v3/domains` and `GET|POST /v3/:domain/mailing_lists`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured messages (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured message (id with or without angle brackets).
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `messages.create` (urlencoded + multipart form) | ✅ Supported |
| Events listing (`mg.events.get`, SDK-parseable `paging` URLs) | ✅ Supported (synthesized `accepted` events) |
| Mailing lists create/list/get/update/delete (`/v3/lists*`) | ✅ Supported |
| Domains listing (`GET /v4/domains`, `mg.domains.list`) | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| Message body part required (`text`/`html`/`template`) | ◐ Accepted but not enforced — sends with only a subject are accepted |
| Attachments / inline file uploads | ◐ Accepted as form fields, not stored as binaries |
| Mailing-list members | ⟳ Roadmap |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Webhooks / routes / templates / stats analytics | ⟳ Roadmap |
| Real API-key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the Mailgun envelope `{ "message": "..." }` — the same shape the `mailgun.js` `APIError` reads (`body.message` / `body.error`).

| Status | When |
| --- | --- |
| `400` | missing `from`/`to`/`address` parameter, bad body |
| `401` | missing/invalid Basic auth (`{ "message": "Invalid private key" }`) |
| `404` | unknown endpoint, missing mailing list, or missing captured message |
| `405` | method not allowed for the path |

## Manifest

See `services/mailgun/manifest.json`:

- name: `mailgun`, image: `parlel/mailgun:1.0`
- port: `4826`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MAILGUN_API_KEY=key-parlel
MAILGUN_DOMAIN=sandbox.parlel
MAILGUN_BASE_URL=http://localhost:4826
```

<!-- parlel:testenv:end -->
