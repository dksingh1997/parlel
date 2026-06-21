# New Relic

Lightweight, dependency-free, in-memory fake of **New Relic** (NerdGraph + Insights event insert) for testing observability code. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4878`

## Quick start

```js
import { NewRelicServer } from "./services/new-relic/src/server.js";

const server = new NewRelicServer(4878);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with the `API-Key` header (any non-empty key is accepted):

```bash
curl -H "API-Key: parlel" -H "Content-Type: application/json" \
  -d '{"query":"{ actor { user { name } } }"}' \
  http://127.0.0.1:4878/graphql
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `NEW_RELIC_API_KEY=parlel`, `NEW_RELIC_ACCOUNT_ID=1`, `NEW_RELIC_BASE_URL=http://127.0.0.1:4878`, then issue NerdGraph queries or Insights inserts. The MCP server proxies the HTTP endpoints below so an agent can query telemetry without a real New Relic account.

## Implemented operations

All endpoints (except `/`, `/health`) require an `API-Key` header (any non-empty key accepted).

### NerdGraph — `POST /graphql`

A **real minimal GraphQL dispatch**: the incoming query is tokenized, parsed into a field tree (with arguments + nested selection sets), and resolved against the in-memory model. Only the fields you select are returned.

- `actor { user { id name email } }` — the authenticated user.
- `actor { account(id: N) { nrql(query: "...") { results } } }` — run an NRQL query. `COUNT(*)` returns `[{ count }]`; otherwise the matching inserted events (capped at 100).

### Insights event insert — `POST /v1/accounts/:id/events`

- Accepts a single event object or an array → `{ success: true }`. Inserted events are queryable via NRQL `count(*)`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `GET /__parlel/events` — inspect all captured events grouped by account.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| NerdGraph `actor { user }`, `account.nrql` | ✅ Supported (real parse + resolve) |
| Insights event insert + NRQL `count(*)` reflection | ✅ Supported |
| Selection-set-aware responses | ✅ Supported |
| Full NRQL grammar (WHERE, FACET, TIMESERIES, aggregations) | ◐ `count(*)` + raw passthrough only |
| Full NerdGraph schema (entities, dashboards, alerts, workloads) | ⟳ Roadmap |
| GraphQL variables / fragments / aliases | ◐ Variable defs parsed but ignored |

## Manifest

See `services/new-relic/manifest.json`:

- name: `new-relic`, port: `4878`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `NEW_RELIC_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
NEW_RELIC_API_KEY=parlel
NEW_RELIC_LICENSE_KEY=parlel
NEW_RELIC_ACCOUNT_ID=1
NEW_RELIC_BASE_URL=http://localhost:4878
```

<!-- parlel:testenv:end -->
