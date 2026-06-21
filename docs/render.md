# Render

Lightweight, dependency-free, in-memory fake of the **Render API v1** for testing deploy automation. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4881`

## Quick start

```js
import { RenderServer } from "./services/render/src/server.js";

const server = new RenderServer(4881);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with `Authorization: Bearer <key>` (any non-empty key accepted):

```bash
curl -H "Authorization: Bearer parlel" http://127.0.0.1:4881/v1/services
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `RENDER_API_KEY=parlel` and `RENDER_BASE_URL=http://127.0.0.1:4881`, then drive the Render REST API v1. The MCP server proxies the endpoints below so an agent can manage services and deploys without a real Render account.

## Implemented operations

All `/v1/*` routes require `Authorization: Bearer <key>` (any non-empty key accepted). List endpoints return arrays of `{ <resource>, cursor }` objects (Render's cursor-pagination shape).

- `GET /v1/owners` — list owners (`[{ owner, cursor }]`).
- `GET /v1/services` — list services (`[{ service, cursor }]`).
- `POST /v1/services` — create a service → `201 { service, deployId }`. Service shape: `{ id, type: "web_service", name, ownerId, repo, branch, ... }`.
- `GET /v1/services/:id` — retrieve a service.
- `PATCH /v1/services/:id` — update a service (name, serviceDetails).
- `DELETE /v1/services/:id` — delete a service (`204`).
- `POST /v1/services/:id/deploys` — trigger a deploy → `201 { id, status: "created", commit, ... }`.
- `GET /v1/services/:id/deploys` — list deploys (`[{ deploy, cursor }]`).
- `GET /v1/services/:id/deploys/:deployId` — retrieve a deploy.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Service create/list/get/update/delete | ✅ Supported |
| Deploy create/list/get | ✅ Supported |
| Owners list | ✅ Supported |
| Real build/deploy execution | ⟳ Roadmap — Intentionally unsupported (status stays `created`) |
| Env-vars / secret files / custom domains endpoints | ⟳ Roadmap |
| Postgres / Redis / cron-job resources | ⟳ Roadmap |
| Cursor pagination semantics (limit/cursor params) | ◐ Cursors generated, single page only |

## Manifest

See `services/render/manifest.json`:

- name: `render`, port: `4881`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `RENDER_API_KEY`, `RENDER_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
RENDER_API_KEY=parlel
RENDER_BASE_URL=http://localhost:4881
```

<!-- parlel:testenv:end -->
