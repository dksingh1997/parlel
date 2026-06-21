# Netlify

Lightweight, dependency-free, in-memory Netlify API (api/v1) fake for testing code that uses the `netlify` Node SDK or the raw Netlify REST API.

Default port: `4771`

## Quick start

```js
import { NetlifyServer } from "./services/netlify/src/server.js";

const server = new NetlifyServer(4771);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const res = await fetch("http://127.0.0.1:4771/api/v1/user", {
  headers: { Authorization: "Bearer nfp_parlel" },
});
const user = await res.json();
// user.email => "parlel-user@parlel.dev"
```

## Access via MCP / preview URL

- REST base URL: `http://127.0.0.1:4771/api/v1`
- Set `NETLIFY_AUTH_TOKEN=nfp_parlel` and `NETLIFY_API_URL=http://127.0.0.1:4771`.

All `/api/v1/*` routes require `Authorization: Bearer <token>` (any non-empty token accepted).

## Implemented operations

State is in-memory and ephemeral.

- `GET /api/v1/user` — the current authenticated user.
- `GET /api/v1/sites` — list sites.
- `POST /api/v1/sites` — create a site (`201`).
- `GET /api/v1/sites/:id` — retrieve a site (by id or name).
- `PUT/PATCH /api/v1/sites/:id` — update name/custom domain.
- `DELETE /api/v1/sites/:id` — delete (`204`).
- `GET /api/v1/sites/:id/deploys` — list deploys for a site.
- `POST /api/v1/sites/:id/deploys` — create a deploy (instantly `ready`).
- `GET /api/v1/sites/:id/deploys/:deploy_id` — retrieve a deploy.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/sites` — list site ids.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /api/v1/user` | ✅ Supported |
| Sites list / create / get / update / delete | ✅ Supported |
| Deploys list / create / get | ✅ Supported |
| Bearer auth | ✅ Required (any non-empty token) |
| Real file upload / build / digest deploy | ⟳ Roadmap — Deploys are instantly `ready` |
| Forms / functions / DNS / hooks | ⟳ Roadmap |
| Pagination headers | ✓ By design — Not emitted |
| Scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Netlify error envelope: `{ "code": 404, "message": "..." }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid authorization |
| `404` | unknown resource |
| `405` | method not allowed |

## Manifest

See `services/netlify/manifest.json`:

- name: `netlify`, image: `parlel/netlify:1`
- port: `4771`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `NETLIFY_AUTH_TOKEN`, `NETLIFY_API_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
NETLIFY_AUTH_TOKEN=nfp_parlel
NETLIFY_API_URL=http://localhost:4771
```

<!-- parlel:testenv:end -->
