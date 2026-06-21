# SparkPost

Lightweight, dependency-free, in-memory SparkPost API v1 fake for testing code that uses the real `sparkpost` Node SDK (or the language-agnostic SparkPost REST API).

Default port: `4830`

## Quick start

Start the server:

```js
import { SparkpostServer } from "./services/sparkpost/src/server.js";

const server = new SparkpostServer(4830);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it. SparkPost uses a **raw** `Authorization` header (no `Bearer` prefix):

```js
await fetch("http://127.0.0.1:4830/api/v1/transmissions", {
  method: "POST",
  headers: { Authorization: "parlel-sparkpost-key", "Content-Type": "application/json" },
  body: JSON.stringify({
    content: { from: "sender@parlel.dev", subject: "Hello", html: "<b>Hi</b>" },
    recipients: [{ address: { email: "recipient@parlel.dev" } }],
  }),
});
// => { results: { total_rejected_recipients: 0, total_accepted_recipients: 1, id } }
```

Every send is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4830`. Use `SPARKPOST_BASE_URL` to point
clients/agents at it. Captured mail lives at `GET /__parlel/messages`.

## Implemented operations

All `/api/v1/*` routes require a raw `Authorization: <api-key>` header. State is in-memory and ephemeral.

- `POST /api/v1/transmissions` — send a transmission (`content.from`, `recipients[].address.email`). Captures and returns `{ results: { total_rejected_recipients, total_accepted_recipients, id } }`.
- `GET /api/v1/transmissions` — list transmissions.
- `GET /api/v1/transmissions/:id` — retrieve a transmission.
- `GET /api/v1/templates` — list templates.
- `POST /api/v1/templates` — create a template (`id` + `content` required).
- `GET /api/v1/account` — account info.

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
| `transmissions.send` | ✅ Supported |
| Transmissions list/get | ✅ Supported |
| Templates (create/list) | ✅ Supported |
| Account info | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Real template substitution / rendering | ◐ Accepted; not rendered |
| Recipient lists / suppressions / webhooks / message events | ⟳ Roadmap |
| Real API-key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the SparkPost envelope `{ "errors": [{ "message", "code", "description" }] }`.

| Status | When |
| --- | --- |
| `401` | missing/empty `Authorization` |
| `400` | malformed body |
| `422` | missing `content.from` or `recipients` |
| `404` | unknown transmission / endpoint |

## Manifest

See `services/sparkpost/manifest.json`:

- name: `sparkpost`, image: `parlel/sparkpost:1.0`
- port: `4830`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SPARKPOST_API_KEY`, `SPARKPOST_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SPARKPOST_API_KEY=parlel-sparkpost-key
SPARKPOST_BASE_URL=http://localhost:4830
```

<!-- parlel:testenv:end -->
