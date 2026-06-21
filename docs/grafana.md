# Grafana

Lightweight, dependency-free, in-memory fake of the **Grafana HTTP API** for testing dashboard/datasource automation. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4879`

## Quick start

```js
import { GrafanaServer } from "./services/grafana/src/server.js";

const server = new GrafanaServer(4879);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with a service-account token via the `Authorization: Bearer <token>` header (any non-empty token accepted):

```bash
curl -H "Authorization: Bearer parlel" http://127.0.0.1:4879/api/org
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `GRAFANA_TOKEN=parlel` and `GRAFANA_BASE_URL=http://127.0.0.1:4879`, then drive the Grafana HTTP API. The MCP server proxies the endpoints below so an agent can upsert dashboards and manage datasources without a real Grafana instance.

## Two health endpoints

There are **two distinct health paths** and both are served:

- `GET /health` → `{ status: "ok" }` — the parlel infra health check (unauthenticated).
- `GET /api/health` → `{ database: "ok", version }` — the real Grafana health endpoint (unauthenticated, matching Grafana).

## Implemented operations

All `/api/*` routes (except `/api/health`) require `Authorization: Bearer <token>` (any non-empty token accepted).

- `POST /api/dashboards/db` — create/update a dashboard (upsert) → `{ id, uid, url, status: "success", version, slug }`. Re-posting with the same `uid` bumps `version`.
- `GET /api/dashboards/uid/:uid` — retrieve a dashboard (`{ dashboard, meta }`).
- `DELETE /api/dashboards/uid/:uid` — delete a dashboard.
- `GET /api/datasources` — list datasources (array). A default Prometheus source is seeded.
- `POST /api/datasources` — create a datasource (`{ id, message, name, datasource }`).
- `GET /api/datasources/:id` — retrieve a datasource.
- `DELETE /api/datasources/:id` — delete a datasource.
- `GET /api/org` — current organization (`{ id, name }`).
- `GET /api/health` — Grafana health (`{ database: "ok", version }`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — parlel health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Dashboard upsert/get/delete, version bump, slug/url | ✅ Supported |
| Datasource list/create/get/delete | ✅ Supported |
| `GET /api/org`, both health endpoints | ✅ Supported |
| Folders, alerting, annotations, users/teams, provisioning | ⟳ Roadmap |
| Datasource query proxy (`/api/datasources/proxy`) | ⟳ Roadmap |
| Dashboard permissions / versions history API | ⟳ Roadmap |
| Token validity / role enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/grafana/manifest.json`:

- name: `grafana`, port: `4879`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `GRAFANA_TOKEN`, `GRAFANA_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GRAFANA_TOKEN=parlel
GRAFANA_API_KEY=parlel
GRAFANA_BASE_URL=http://localhost:4879
```

<!-- parlel:testenv:end -->
