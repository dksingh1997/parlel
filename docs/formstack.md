# Formstack

Lightweight, dependency-free, in-memory Formstack Forms API v2 fake for testing form code.

Default port: `4853`

## Quick start

```js
import { FormstackServer } from "./services/formstack/src/server.js";

const server = new FormstackServer(4853);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a Formstack client at `http://127.0.0.1:4853`. Authenticate with a Bearer
token (or `?access_token=`); any non-empty value is accepted. Paths carry a
`.json` suffix:

```js
const res = await fetch("http://127.0.0.1:4853/api/v2/form.json", {
  headers: { Authorization: "Bearer parlel" },
});
const { forms, total, page, per_page } = await res.json();
```

## List shape

```json
{ "forms": [], "total": 0, "page": 1, "per_page": 25 }
```

## Implemented operations

All `/api/v2/*` routes require Bearer auth. State is in-memory.

- `GET /api/v2/form.json` — list forms (list shape).
- `POST /api/v2/form.json` — create a form.
- `GET /api/v2/form/:id.json` — retrieve a form (includes `fields`).
- `GET /api/v2/form/:id/submission.json` — list a form's submissions (`{ submissions, total, page, per_page, pages }`).
- `POST /api/v2/form/:id/submission.json` — create a submission (`field_<id>=value` keys, or a `data` object).
- `GET /api/v2/submission/:id.json` — retrieve a submission.
- `DELETE /api/v2/submission/:id.json` — delete a submission.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `FORMSTACK_BASE_URL` (`http://127.0.0.1:4853`). When
running in the parlel pool, an MCP tool / preview URL proxies to this base URL —
point your Formstack client at that URL with a Bearer token and every
`/api/v2/*.json` endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Forms list/create/get | ✅ Supported |
| Submissions list/create/get/delete | ✅ Supported |
| `.json` path suffix | ✅ Supported |
| List shape `{forms,total,page,per_page}` | ✅ Supported |
| Bearer **and** `?access_token=` | ✅ Supported |
| Fields/folders editing, webhooks | ⟳ Roadmap |
| Real cursor pagination | ◐ Single-page |
| Token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ status: "error", error }`:

| Status | When |
| --- | --- |
| `401` | missing Bearer/`access_token` |
| `404` | unknown form or submission |

## Manifest

See `services/formstack/manifest.json`:

- name: `formstack`, port: `4853`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `FORMSTACK_API_KEY`, `FORMSTACK_ACCESS_TOKEN`, `FORMSTACK_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FORMSTACK_API_KEY=parlel
FORMSTACK_ACCESS_TOKEN=parlel
FORMSTACK_BASE_URL=http://localhost:4853
```

<!-- parlel:testenv:end -->
