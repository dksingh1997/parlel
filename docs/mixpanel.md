# Mixpanel

Lightweight, dependency-free, in-memory Mixpanel ingestion + query API fake for testing code that uses the real `mixpanel` Node SDK (and the language-agnostic Mixpanel HTTP API).

Default port: `4808`

## Quick start

```js
import { MixpanelServer } from "./services/mixpanel/src/server.js";

const server = new MixpanelServer(4808);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `mixpanel` client at it via the `host` option:

```js
import Mixpanel from "mixpanel";

const mp = Mixpanel.init("parlel", { host: "127.0.0.1:4808", protocol: "http" });
mp.track("Signed Up", { distinct_id: "user-123", plan: "pro" });
```

Every ingested event is held in memory and inspectable via `/__parlel/*`.

## Implemented operations

Ingestion uses Basic auth (project token as username); any credentials are accepted.

### Ingestion

- `POST /track` — ingest event(s). Accepts a base64-encoded `data` query/form param, a JSON object, or a JSON array. Returns `1` on success, `0` when nothing valid was found.
- `POST /import` — historical ingest. Returns `{ code: 200, num_records_imported, status: "OK" }`.
- `POST /engage` — people profile updates (`$set`, `$set_once`, `$unset`). Returns `1`.

### Query

- `GET /api/2.0/events` — query captured events (optional `?event=["Name"]` filter). Returns `{ legend_size, data, events }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state.
- `GET /__parlel/events` — list captured events.
- `GET /__parlel/people` — list people profiles.
- `DELETE /__parlel/events` — clear captured events.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool the service is reachable at its preview URL (host/port shown by the pool); set the SDK's `host`/`protocol` to that URL. Through the parlel MCP server the ingestion and query routes are exposed as a tool surface, so an AI agent can drive `/track`, `/import`, `/engage` and query `/api/2.0/events` directly.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `track` (data param + JSON + array) | ✅ Supported |
| `import` historical ingest | ✅ Supported |
| `engage` people updates | ✅ Supported |
| `events` query | ✅ Supported |
| Captured-event inspection | ✅ Supported (parlel extension) |
| JQL / segmentation / funnels / retention math | ⟳ Roadmap |
| Real time-series aggregation | ✓ By design — Not computed |
| Basic-auth credential validation | ◐ Any credentials accepted |

## Manifest

See `services/mixpanel/manifest.json`:

- name: `mixpanel`, image: `parlel/mixpanel:1.0`
- port: `4808`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `MIXPANEL_TOKEN`, `MIXPANEL_API_SECRET`, `MIXPANEL_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MIXPANEL_TOKEN=parlel
MIXPANEL_API_SECRET=parlel-secret
MIXPANEL_HOST=http://localhost:4808
MIXPANEL_BASE_URL=http://localhost:4808
```

<!-- parlel:testenv:end -->
