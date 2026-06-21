# CircleCI

Lightweight, dependency-free, in-memory fake of the **CircleCI API v2** for testing code that talks to the CircleCI REST API. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4876`

## Quick start

```js
import { CircleciServer } from "./services/circleci/src/server.js";

const server = new CircleciServer(4876);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point any CircleCI v2 client at `http://127.0.0.1:4876` and authenticate with the `Circle-Token` header (any non-empty token is accepted):

```bash
curl -H "Circle-Token: parlel" http://127.0.0.1:4876/api/v2/me
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `CIRCLECI_BASE_URL=http://127.0.0.1:4876` and `CIRCLECI_TOKEN=parlel` in your environment, then drive it with the CircleCI v2 REST surface. The MCP server proxies the same HTTP endpoints documented below, so an agent can create pipelines and inspect workflows without touching real CircleCI.

## Implemented operations

All `/api/v2/*` routes require a `Circle-Token: <token>` header (any non-empty token accepted). List endpoints use the `{ items: [], next_page_token }` envelope.

- `GET /api/v2/me` — the authenticated user (`{ id, login, name }`).
- `GET /api/v2/project/:project-slug` — project metadata (slug is `gh/org/repo`).
- `POST /api/v2/project/:project-slug/pipeline` — trigger a pipeline → `201 { id, state: "created", number, created_at }`. Also spawns a deterministic workflow + job.
- `GET /api/v2/project/:project-slug/pipeline` — list pipelines for the project.
- `GET /api/v2/pipeline/:id` — retrieve a pipeline.
- `GET /api/v2/pipeline/:id/workflow` — list a pipeline's workflows.
- `GET /api/v2/workflow/:id` — retrieve a workflow.

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
| `GET /me`, project, pipeline create/get, workflow list/get | ✅ Supported |
| `{ items, next_page_token }` list envelope | ✅ Supported |
| Deterministic ids per run | ✅ Supported |
| Real build execution / artifacts / test results | ⟳ Roadmap — Intentionally unsupported |
| Insights / contexts / schedules / orbs | ⟳ Roadmap |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Pagination beyond a single page | ⟳ Roadmap — Single page only (`next_page_token: null`) |

## Manifest

See `services/circleci/manifest.json`:

- name: `circleci`, port: `4876`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CIRCLECI_TOKEN`, `CIRCLECI_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CIRCLECI_TOKEN=parlel
CIRCLECI_BASE_URL=http://localhost:4876
```

<!-- parlel:testenv:end -->
