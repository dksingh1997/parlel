# Drip

Lightweight, dependency-free, in-memory Drip API v2 fake for testing code that uses the language-agnostic Drip REST API.

Default port: `4833`

## Quick start

Start the server:

```js
import { DripServer } from "./services/drip/src/server.js";

const server = new DripServer(4833);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it. Drip uses HTTP Basic auth with the API token as the username (blank password):

```js
await fetch("http://127.0.0.1:4833/v2/9999999/subscribers", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from("parlel-drip-token:").toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ subscribers: [{ email: "subscriber@parlel.dev", tags: ["lead"] }] }),
});
// => { subscribers: [{ id, email, status, ... }] }
```

Recorded events are captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4833`. Use `DRIP_BASE_URL` to point
clients/agents at it. Captured events live at `GET /__parlel/messages`.

## Implemented operations

All `/v2/:accountId/*` routes require HTTP Basic auth (token as username). Resources are wrapped in arrays. State is in-memory and ephemeral.

- `POST /v2/:accountId/subscribers` — create or upsert a subscriber (`{ subscribers: [{ email, ... }] }`). Returns `{ subscribers: [{...}] }`.
- `GET /v2/:accountId/subscribers` — list subscribers (`{ subscribers, meta }`).
- `GET /v2/:accountId/subscribers/:id` — get a subscriber by id or email.
- `DELETE /v2/:accountId/subscribers/:id` — delete a subscriber (`204`).
- `POST /v2/:accountId/events` — record an event (`{ events: [{ email, action }] }`); captured (`204`).
- `GET /v2/:accountId/campaigns` — list campaigns (a seeded default exists).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured events (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured event.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Subscribers (create/upsert/list/get/delete) | ✅ Supported |
| Events (record) | ✅ Supported |
| Campaigns listing | ✅ Supported |
| Captured event inspection | ✅ Supported (parlel extension) |
| Actual workflow / email delivery | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Workflows / forms / orders / conversions / webhooks | ⟳ Roadmap |
| Subscriber → campaign subscribe lifecycle | ◐ Not modeled |
| Real token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the Drip envelope `{ "errors": [{ "code", "message", "attribute" }] }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid auth |
| `422` | invalid/missing `email`, `action`, or missing resource array |
| `404` | unknown subscriber / campaign / endpoint |

## Manifest

See `services/drip/manifest.json`:

- name: `drip`, image: `parlel/drip:1.0`
- port: `4833`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `DRIP_API_TOKEN`, `DRIP_ACCOUNT_ID`, `DRIP_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DRIP_API_TOKEN=parlel-drip-token
DRIP_ACCOUNT_ID=9999999
DRIP_BASE_URL=http://localhost:4833
```

<!-- parlel:testenv:end -->
