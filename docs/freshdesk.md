# Freshdesk

Lightweight, dependency-free, in-memory fake of the Freshdesk API v2 for testing code that talks to the Freshdesk REST API directly.

Default port: `4782`

## Quick start

```js
import { FreshdeskServer } from "./services/freshdesk/src/server.js";

const server = new FreshdeskServer(4782);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const base = "http://127.0.0.1:4782";
const basic = Buffer.from("pat-parlel:X").toString("base64");
const res = await fetch(`${base}/api/v2/tickets`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
  body: JSON.stringify({ subject: "Help", description: "broke", email: "u@parlel.dev" }),
});
// => { id, subject, status, priority, ... }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4782`, reachable through the parlel MCP/preview proxy under the slug `freshdesk`.

## Implemented operations

All `/api/v2/*` routes require `Authorization: Basic <base64(apikey:X)>` (or `Bearer`). State is in-memory and ephemeral. Resources and collections are plain JSON (no wrapping; collections are bare arrays).

### Tickets — `/api/v2/tickets`

- `POST /api/v2/tickets` — create (`subject`, `description`, and `email`/`requester_id` required; defaults `status: 2`, `priority: 1`).
- `GET /api/v2/tickets` — list.
- `GET /api/v2/tickets/:id` — retrieve.
- `PUT /api/v2/tickets/:id` — update.
- `DELETE /api/v2/tickets/:id` — delete (`204`).

### Contacts — `/api/v2/contacts`

CRUD surface (`name` required on create).

### Companies — `/api/v2/companies`

CRUD surface (`name` required on create).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Tickets / Contacts / Companies CRUD | ✅ Supported |
| Basic (apikey) + Bearer auth | ✅ Supported |
| Mandatory-field validation (`400` with `errors[]`) | ✅ Supported |
| Conversations / replies / notes | ⟳ Roadmap |
| Agents / groups / canned responses | ⟳ Roadmap |
| Pagination (`Link` headers) / filters | ◐ Returns full collection |
| API-key validity | ◐ Any well-formed Basic/Bearer accepted |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the Freshdesk envelope `{ description, errors: [{ field, message, code }] }`.

| Status | When |
| --- | --- |
| `400` | malformed JSON / `Validation failed` with `errors[]` |
| `401` | no Basic/Bearer auth |
| `404` | unknown id / resource |
| `405` | method not allowed for the path |

## Manifest

See `services/freshdesk/manifest.json`: name `freshdesk`, port `4782`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `FRESHDESK_API_KEY`, `FRESHDESK_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FRESHDESK_API_KEY=pat-parlel
FRESHDESK_BASE_URL=http://localhost:4782
```

<!-- parlel:testenv:end -->
