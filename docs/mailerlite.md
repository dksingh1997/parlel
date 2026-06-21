# MailerLite

Lightweight, dependency-free, in-memory MailerLite API fake for testing code that uses the real `@mailerlite/mailerlite-nodejs` SDK (or the language-agnostic MailerLite REST API).

Default port: `4831`

## Quick start

Start the server:

```js
import { MailerliteServer } from "./services/mailerlite/src/server.js";

const server = new MailerliteServer(4831);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it (Bearer auth):

```js
await fetch("http://127.0.0.1:4831/api/subscribers", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-mailerlite-key", "Content-Type": "application/json" },
  body: JSON.stringify({ email: "subscriber@parlel.dev", fields: { name: "Sub" } }),
});
// => { data: { id, email, status, fields, ... } }
```

Campaign creation is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4831`. Use `MAILERLITE_BASE_URL` to point
clients/agents at it. Captured campaigns live at `GET /__parlel/messages`.

## Implemented operations

All `/api/*` routes require Bearer auth. Responses use the MailerLite envelopes `{ data: {...} }` and `{ data: [], meta, links }`. State is in-memory and ephemeral.

- `GET /api/subscribers` — list subscribers.
- `POST /api/subscribers` — create or upsert a subscriber (`email` required).
- `GET /api/subscribers/:id` — get a subscriber by id or email.
- `PUT /api/subscribers/:id` — update a subscriber.
- `DELETE /api/subscribers/:id` — delete a subscriber (`204`).
- `GET /api/groups` — list groups.
- `POST /api/groups` — create a group (`name` required).
- `POST /api/campaigns` — create a campaign (`name` + `type` required); captured.
- `GET /api/campaigns` — list campaigns.
- `GET /api/account` — account info.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured campaigns (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured campaign.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Subscribers CRUD (create/upsert/list/get/update/delete) | ✅ Supported |
| Groups (create/list) | ✅ Supported |
| Campaigns (create/list) | ✅ Supported |
| Account info | ✅ Supported |
| Captured campaign inspection | ✅ Supported (parlel extension) |
| Actual campaign delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Automations / forms / segments / webhooks | ⟳ Roadmap |
| Real pagination cursors | ◐ Single page; `meta`/`links` returned but not truly paginated |
| Real API-key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the MailerLite envelope `{ "message": "...", "errors": { field: [..] } }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer auth (`Unauthenticated.`) |
| `422` | validation failure (e.g. missing/invalid `email`, `name`) |
| `404` | unknown subscriber / endpoint |

## Manifest

See `services/mailerlite/manifest.json`:

- name: `mailerlite`, image: `parlel/mailerlite:1.0`
- port: `4831`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `MAILERLITE_API_KEY`, `MAILERLITE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MAILERLITE_API_KEY=parlel-mailerlite-key
MAILERLITE_BASE_URL=http://localhost:4831
```

<!-- parlel:testenv:end -->
