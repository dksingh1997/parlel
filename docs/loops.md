# Loops

Lightweight, dependency-free, in-memory Loops API fake for testing code that uses the real `@loops/loops` SDK (or the language-agnostic Loops REST API).

Default port: `4834`

## Quick start

Start the server:

```js
import { LoopsServer } from "./services/loops/src/server.js";

const server = new LoopsServer(4834);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it (Bearer auth):

```js
await fetch("http://127.0.0.1:4834/v1/transactional", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-loops-key", "Content-Type": "application/json" },
  body: JSON.stringify({
    transactionalId: "tmpl_welcome",
    email: "recipient@parlel.dev",
    dataVariables: { name: "Parlel" },
  }),
});
// => { success: true }
```

Every transactional send is captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4834`. Use `LOOPS_BASE_URL` to point
clients/agents at it. Captured mail lives at `GET /__parlel/messages`.

## Implemented operations

All `/v1/*` routes require Bearer auth. State is in-memory and ephemeral.

- `POST /v1/transactional` — send a transactional email (`transactionalId` + `email` required). Captures and returns `{ success: true }`.
- `POST /v1/contacts/create` — create a contact (`email` required); returns `{ success: true, id }`.
- `PUT /v1/contacts/update` — update (upsert) a contact by email.
- `GET /v1/contacts/find?email=` — find a contact by email (returns an array, empty if none).
- `POST /v1/events/send` — send an event (`eventName` + `email`/`userId` required).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured transactional emails (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured email.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `sendTransactionalEmail` | ✅ Supported |
| Contacts (create/update-upsert/find) | ✅ Supported |
| Events (send) | ✅ Supported |
| API-key validation | ✅ Supported |
| Captured-mail inspection | ✅ Supported (parlel extension) |
| Actual email delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Real template rendering / data variables | ◐ Accepted; not rendered |
| Mailing lists / contact properties schema / attachments | ⟳ Roadmap |
| Real API-key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error shapes

Errors use the Loops envelope `{ "success": false, "message": "..." }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer auth |
| `400` | missing `transactionalId`/`eventName`, invalid email, malformed body |
| `409` | contact already exists on create |
| `404` | unknown endpoint |

## Manifest

See `services/loops/manifest.json`:

- name: `loops`, image: `parlel/loops:1.0`
- port: `4834`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `LOOPS_API_KEY`, `LOOPS_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
LOOPS_API_KEY=parlel-loops-key
LOOPS_BASE_URL=http://localhost:4834
```

<!-- parlel:testenv:end -->
