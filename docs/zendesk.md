# Zendesk

Lightweight, dependency-free, in-memory fake of the Zendesk Support API v2 for testing code that uses `node-zendesk` (or the REST API directly).

Default port: `4781`

## Quick start

```js
import { ZendeskServer } from "./services/zendesk/src/server.js";

const server = new ZendeskServer(4781);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const base = "http://127.0.0.1:4781";
const basic = Buffer.from("agent@parlel.dev/token:pat-parlel").toString("base64");
const res = await fetch(`${base}/api/v2/tickets.json`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
  body: JSON.stringify({ ticket: { subject: "Help", comment: { body: "broken" } } }),
});
// => { ticket: { id, subject, status, ... } }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4781`, reachable through the parlel MCP/preview proxy under the slug `zendesk`. The `.json` suffix on resource paths is optional.

## Implemented operations

All `/api/v2/*` routes require either `Authorization: Basic <...>` (email/token) or `Authorization: Bearer <...>` (OAuth). State is in-memory and ephemeral.

Single resources are wrapped under the singular key (`{ ticket: {...} }`); collections under the plural key with a `count` (`{ tickets: [...], count, next_page, previous_page }`).

### Tickets — `/api/v2/tickets`

- `POST /api/v2/tickets.json` — create (`subject` or `comment` required; defaults `status: "open"`).
- `GET /api/v2/tickets.json` — list.
- `GET /api/v2/tickets/:id.json` — retrieve.
- `PUT /api/v2/tickets/:id.json` — update.
- `DELETE /api/v2/tickets/:id.json` — delete (`204`).

### Users — `/api/v2/users.json`

CRUD surface (`name` required on create).

### Organizations — `/api/v2/organizations.json`

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
| Tickets / Users / Organizations CRUD | ✅ Supported |
| Basic + Bearer auth | ✅ Supported |
| Wrapped single + collection envelopes | ✅ Supported |
| Required-field validation (`422`) | ✅ Supported |
| Comments / audits / side-loading (`include`) | ⟳ Roadmap |
| Search API / incremental exports | ⟳ Roadmap |
| Cursor pagination (`next_page` always null) | ◐ Single page |
| Token/credential validity | ◐ Any well-formed Basic/Bearer accepted |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the Zendesk envelope `{ error, description }`.

| Status | `error` | When |
| --- | --- | --- |
| `400` | `InvalidJson` | malformed JSON body |
| `401` | (string) | no Basic/Bearer auth |
| `404` | `RecordNotFound` | unknown id / resource |
| `405` | `MethodNotAllowed` | method not allowed for the path |
| `422` | `RecordInvalid` | missing required field |

## Manifest

See `services/zendesk/manifest.json`: name `zendesk`, port `4781`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `ZENDESK_API_TOKEN`, `ZENDESK_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ZENDESK_API_TOKEN=pat-parlel
ZENDESK_BASE_URL=http://localhost:4781
```

<!-- parlel:testenv:end -->
