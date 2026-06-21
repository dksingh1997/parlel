# Amplitude

Lightweight, dependency-free, in-memory Amplitude HTTP API v2 fake for testing code that uses the real `@amplitude/analytics-node` SDK (and the language-agnostic Amplitude HTTP V2 / Batch / Identify APIs).

Default port: `4809`

## Quick start

```js
import { AmplitudeServer } from "./services/amplitude/src/server.js";

const server = new AmplitudeServer(4809);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@amplitude/analytics-node` client at it via `serverUrl`:

```js
import { init, track } from "@amplitude/analytics-node";

init("parlel", { serverUrl: "http://127.0.0.1:4809/2/httpapi" });
track("Signup", { plan: "pro" }, { user_id: "user-1" });
```

Every ingested event is held in memory and inspectable via `/__parlel/*`.

## Implemented operations

Authentication is via `api_key` supplied in the request body (matching the HTTP V2 API).

### Ingestion

- `POST /2/httpapi` — HTTP API V2 event ingest. Returns `{ code: 200, events_ingested, payload_size_bytes, server_upload_time }`.
- `POST /batch` — Batch Event Upload API (same handling/shape).
- `POST /identify` — Identify API; `identification` is a JSON-encoded array or object. Returns `{ code: 200, identifies_ingested, server_upload_time }`.

### Query

- `GET|POST /api/2/usersearch` — dashboard user search (`?user=` or `{ user }`). Returns `{ matches: [...], type }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state.
- `GET /__parlel/events` — list captured events.
- `GET /__parlel/users` — list identified users.
- `DELETE /__parlel/events` — clear captured events.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); set `serverUrl` to `<preview-url>/2/httpapi`. Through the parlel MCP server, the ingest/identify/usersearch routes are exposed as a tool surface so an AI agent can drive ingestion and inspect what landed.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `/2/httpapi` event ingest (v2 shape) | ✅ Supported |
| `/batch` ingest | ✅ Supported |
| `/identify` user properties | ✅ Supported |
| `/api/2/usersearch` lookup | ✅ Supported |
| Captured-event inspection | ✅ Supported (parlel extension) |
| Real charts / behavioral cohorts | ⟳ Roadmap |
| Throttling / `429` flow control | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| `api_key` validity check | ✓ By design — Intentional for a local, zero-cost test emulator |

## Manifest

See `services/amplitude/manifest.json`:

- name: `amplitude`, image: `parlel/amplitude:1.0`
- port: `4809`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `AMPLITUDE_API_KEY`, `AMPLITUDE_SECRET_KEY`, `AMPLITUDE_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AMPLITUDE_API_KEY=parlel
AMPLITUDE_SECRET_KEY=parlel-secret
AMPLITUDE_HOST=http://localhost:4809
AMPLITUDE_BASE_URL=http://localhost:4809
```

<!-- parlel:testenv:end -->
