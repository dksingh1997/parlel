# Intercom

Lightweight, dependency-free, in-memory fake of the Intercom REST API for testing code that uses the `intercom-client` Node SDK (or the REST API directly).

Default port: `4780`

## Quick start

```js
import { IntercomServer } from "./services/intercom/src/server.js";

const server = new IntercomServer(4780);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const base = "http://127.0.0.1:4780";
const res = await fetch(`${base}/contacts`, {
  method: "POST",
  headers: {
    Authorization: "Bearer pat-parlel",
    "Intercom-Version": "2.11",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: "a@parlel.dev", name: "Ada" }),
});
// => { type: "contact", id, email, ... }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4780`, reachable through the parlel MCP/preview proxy under the slug `intercom`. The `Intercom-Version` request header is honoured and echoed on the response.

## Implemented operations

All API routes require `Authorization: Bearer <token>` (any non-empty bearer works). State is in-memory and ephemeral.

Object shape: `{ type: "contact", id, ... }`.
List shape: `{ type: "list", data: [...], pages: {...}, total_count }`.

### Contacts — `/contacts`

- `POST /contacts` — create.
- `GET /contacts` — list.
- `GET /contacts/:id` — retrieve.
- `PUT /contacts/:id` — update.
- `DELETE /contacts/:id` — archive/delete.
- `POST /contacts/search` — filter via `{ query: { field, operator, value } }` (`=`, `!=`, `~`).

### Conversations — `/conversations`

- `POST /conversations` — create.
- `GET /conversations` — list (`{ type:"conversation.list", conversations: [] }`).
- `GET /conversations/:id` — retrieve.
- `PUT /conversations/:id` — update.

### Messages — `/messages`

- `POST /messages` — create an admin-initiated message (`from` required).

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
| Contacts CRUD + search | ✅ Supported |
| Conversations create/list/get/update | ✅ Supported |
| Messages create | ✅ Supported |
| `Intercom-Version` header echo | ✅ Supported |
| Companies / tags / segments / data attributes | ⟳ Roadmap |
| Reply / attach / conversation parts | ⟳ Roadmap |
| Full search operator grammar (AND/OR trees) | ◐ Single-clause subset |
| Token validity / workspace scoping | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the Intercom envelope `{ type: "error.list", request_id, errors: [{ code, message }] }`.

| Status | `code` | When |
| --- | --- | --- |
| `400` | `bad_request` / `parameter_invalid` | malformed JSON / missing `from` |
| `401` | `unauthorized` | no `Authorization: Bearer` header |
| `404` | `not_found` | unknown id / endpoint |
| `405` | `method_not_allowed` | method not allowed for the path |

## Manifest

See `services/intercom/manifest.json`: name `intercom`, port `4780`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `INTERCOM_ACCESS_TOKEN`, `INTERCOM_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
INTERCOM_ACCESS_TOKEN=pat-parlel
INTERCOM_BASE_URL=http://localhost:4780
```

<!-- parlel:testenv:end -->
