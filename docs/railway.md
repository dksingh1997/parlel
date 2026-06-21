# Railway

Lightweight, dependency-free, in-memory fake of the **Railway GraphQL API** for testing deploy automation. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4882`

## Quick start

```js
import { RailwayServer } from "./services/railway/src/server.js";

const server = new RailwayServer(4882);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with `Authorization: Bearer <token>` (any non-empty token accepted):

```bash
curl -H "Authorization: Bearer parlel" -H "Content-Type: application/json" \
  -d '{"query":"{ me { id email } }"}' \
  http://127.0.0.1:4882/graphql/v2
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `RAILWAY_TOKEN=parlel` and `RAILWAY_BASE_URL=http://127.0.0.1:4882`, then issue GraphQL operations against `/graphql/v2`. The MCP server proxies the endpoint below so an agent can manage projects without a real Railway account.

## Implemented operations

`POST /graphql/v2` requires `Authorization: Bearer <token>` (any non-empty token accepted). Responses use `{ data: {...} }`.

A **real minimal GraphQL dispatch**: the document is tokenized, parsed into a field tree (including object-literal arguments, variables, list values, and nested selection sets), and resolved against the in-memory model. Only the selected fields are returned.

- `me { id email name }` — the authenticated user.
- `projects { edges { node { id name } } }` — the Relay-style project connection.
- `mutation projectCreate(input: { name: "..." }) { id name }` — create a project. Supports GraphQL `variables`.
- `mutation projectDelete(id: "...")` — delete a project (returns boolean).

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
| `me`, `projects` connection, `projectCreate`, `projectDelete` | ✅ Supported (real parse + resolve) |
| Object args + GraphQL variables | ✅ Supported |
| Selection-set-aware responses | ✅ Supported |
| Full Railway schema (services, deployments, environments, plugins, volumes) | ⟳ Roadmap |
| Subscriptions / streaming logs | ⟳ Roadmap |
| GraphQL fragments / aliases / directives | ◐ Variable defs parsed but ignored |
| Token validity / team scoping | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/railway/manifest.json`:

- name: `railway`, port: `4882`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `RAILWAY_TOKEN`, `RAILWAY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
RAILWAY_TOKEN=parlel
RAILWAY_API_TOKEN=parlel
RAILWAY_BASE_URL=http://localhost:4882
```

<!-- parlel:testenv:end -->
