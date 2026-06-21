# Tally

Lightweight, dependency-free, in-memory Tally API fake for testing code that talks to the Tally REST API.

Default port: `4848`

## Quick start

```js
import { TallyServer } from "./services/tally/src/server.js";

const server = new TallyServer(4848);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a Tally client at `http://127.0.0.1:4848`. Authenticate with a Bearer
token (any non-empty token is accepted):

```js
const res = await fetch("http://127.0.0.1:4848/forms", {
  headers: { Authorization: "Bearer parlel" },
});
const { items, page, limit, total, hasMore } = await res.json();
```

## List envelope

List endpoints use Tally's envelope:

```json
{ "items": [], "page": 1, "limit": 50, "total": 0, "hasMore": false }
```

## Implemented operations

All routes require `Authorization: Bearer <token>`. State is in-memory.

- `GET /workspaces` — list workspaces (list envelope).
- `GET /forms` — list forms (list envelope).
- `POST /forms` — create a form.
- `GET /forms/:id` — retrieve a form.
- `GET /forms/:id/responses` — list responses (list envelope + `questions`, `totalNumberOfSubmissionsPerFilter`).
- `GET /forms/:id/submissions` — alias of responses.
- `POST /forms/:id/submissions` — create a response (parlel helper for seeding data).

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `TALLY_BASE_URL` (`http://127.0.0.1:4848`). When
running in the parlel pool, an MCP tool / preview URL proxies to this base URL —
point your Tally client at that URL with a Bearer token and every endpoint above
works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /workspaces` | ✅ Supported |
| Forms list/create/get | ✅ Supported |
| Responses & submissions list | ✅ Supported |
| Response creation (seed helper) | ✅ Supported (parlel extension) |
| List envelope `{items,page,limit,total,hasMore}` | ✅ Supported |
| Webhooks / form blocks editing | ⟳ Roadmap |
| Real cursor pagination | ◐ Single-page (`hasMore` always false) |
| API-key validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ message, statusCode }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `404` | unknown form |

## Manifest

See `services/tally/manifest.json`:

- name: `tally`, port: `4848`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `TALLY_API_KEY`, `TALLY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TALLY_API_KEY=parlel
TALLY_BASE_URL=http://localhost:4848
```

<!-- parlel:testenv:end -->
