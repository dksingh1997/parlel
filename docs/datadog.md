# Datadog

Lightweight, dependency-free, in-memory Datadog API (v1/v2) fake for testing code that uses the real `@datadog/datadog-api-client` SDK (and the language-agnostic Datadog REST API).

Default port: `4810`

## Quick start

```js
import { DatadogServer } from "./services/datadog/src/server.js";

const server = new DatadogServer(4810);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real client at it by overriding the server URL / `DD_SITE`:

```js
import { client, v1 } from "@datadog/datadog-api-client";

const configuration = client.createConfiguration({
  authMethods: { apiKeyAuth: "parlel", appKeyAuth: "parlel-app" },
});
configuration.setServerVariables({ site: "127.0.0.1:4810" }); // point at the parlel fake
const api = new v1.MetricsApi(configuration);
```

Every submission is held in memory and inspectable via `/__parlel/*`.

## Implemented operations

Authentication is via the `DD-API-KEY` header (and optional `DD-APPLICATION-KEY`). Any non-empty `DD-API-KEY` is accepted; a missing key returns `403`.

### Metrics & logs

- `POST /api/v1/series` — submit metric series. Returns `202 { status: "ok" }`.
- `POST /api/v2/logs` — submit logs. Returns `202 {}`.
- `POST /api/v1/check_run` — submit service checks. Returns `202 { status: "ok" }`.

### Events

- `POST /api/v1/events` — post an event. Returns `202 { status: "ok", event }`.
- `GET /api/v1/events` — list events.
- `GET /api/v1/events/:id` — retrieve an event.

### Dashboards

- `GET /api/v1/dashboard` — list dashboards.
- `POST /api/v1/dashboard` — create a dashboard.
- `GET /api/v1/dashboard/:id` — retrieve.
- `PUT /api/v1/dashboard/:id` — update.
- `DELETE /api/v1/dashboard/:id` — delete (`{ deleted_dashboard_id }`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state.
- `GET /__parlel/metrics` — list submitted metric series.
- `GET /__parlel/logs` — list submitted logs.
- `GET /__parlel/check_runs` — list submitted service checks.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); point `DD_SITE` / the client server variable at that URL. Through the parlel MCP server, the series/logs/events/dashboard routes are exposed as a tool surface so an AI agent can submit telemetry and inspect what landed.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `v1/series` metric submit | ✅ Supported |
| `v2/logs` log intake | ✅ Supported |
| `v1/events` CRUD (post/get/list) | ✅ Supported |
| `v1/dashboard` CRUD | ✅ Supported |
| `v1/check_run` service checks | ✅ Supported |
| Captured-telemetry inspection | ✅ Supported (parlel extension) |
| Real metric aggregation / querying (`/api/v1/query`) | ⟳ Roadmap |
| Monitors / SLOs / Synthetics | ⟳ Roadmap |
| `DD-API-KEY` validity check against an account | ✓ By design — Intentional for a local, zero-cost test emulator |

## Manifest

See `services/datadog/manifest.json`:

- name: `datadog`, image: `parlel/datadog:1.0`
- port: `4810`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DATADOG_API_KEY=parlel
DD_API_KEY=parlel
DD_APP_KEY=parlel-app
DATADOG_APP_KEY=parlel-app
DD_SITE=http://127.0.0.1:4810
DATADOG_HOST=http://localhost:4810
```

<!-- parlel:testenv:end -->
