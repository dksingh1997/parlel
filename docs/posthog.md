# PostHog

Lightweight, dependency-free, in-memory PostHog API fake for testing code that uses the real `posthog-node` / `posthog-js` SDKs (and the language-agnostic PostHog REST API).

Default port: `4807`

## Quick start

```js
import { PosthogServer } from "./services/posthog/src/server.js";

const server = new PosthogServer(4807);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `posthog-node` client at it via the `host` option:

```js
import { PostHog } from "posthog-node";

const client = new PostHog("phc_parlel_test_key", {
  host: "http://127.0.0.1:4807",
});

client.capture({ distinctId: "user-123", event: "user signed up", properties: { plan: "pro" } });
await client.flush();
```

Every captured event is held in memory and can be inspected via the `/__parlel/*` endpoints.

## Implemented operations

Event ingestion uses the project `api_key` in the request body (no bearer required). The `/api/*` REST surface requires `Authorization: Bearer <personal-api-key>`.

### Event ingestion

- `POST /capture/` — ingest a single event. Returns `200 { status: 1 }`.
- `POST /batch/` — ingest a batch (`{ batch: [...] }`). Returns `200 { status: 1 }`.
- `POST /e/`, `POST /i/` — posthog-js ingest aliases (route to capture).
- `POST /decide/` — feature flag evaluation. Returns `{ featureFlags, featureFlagPayloads, config, ... }`.

### Project REST API (`/api/projects/:id`)

- `GET /api/projects/:id/insights` — list insights (`{ count, results: [...] }`).
- `POST /api/projects/:id/insights` — create an insight (`201`).
- `GET|PATCH|DELETE /api/projects/:id/insights/:insightId` — read / update / delete.
- `GET|POST /api/projects/:id/events` — query captured events (optional `?event=` filter).
- `GET /api/projects/:id/feature_flags` — list feature flags.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/events` — list every captured event (`{ events, count }`).
- `DELETE /__parlel/events` — clear captured events.
- `POST /__parlel/feature_flags` — set a flag value (`{ key, value }`).
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

When run inside a parlel pool, the service is reachable at its preview URL (the host/port shown by the pool). Configure your SDK's `host` to that URL. Through the parlel MCP server, the service is exposed as a tool surface so an AI agent can drive captures and query events without leaving the editor — the same `/capture/`, `/batch/`, `/decide/` and `/api/projects/:id/*` routes are available.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `capture` / `batch` event ingestion | ✅ Supported |
| `/decide` feature flag evaluation | ✅ Supported |
| Insights CRUD | ✅ Supported |
| Events query | ✅ Supported |
| Captured-event inspection | ✅ Supported (parlel extension) |
| Real analytics computation / aggregation | ✓ By design — Not computed (insights return empty `result`) |
| Cohorts / Trends / Funnels math | ⟳ Roadmap |
| Session recording ingestion | ⟳ Roadmap |
| Bearer-token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/posthog/manifest.json`:

- name: `posthog`, image: `parlel/posthog:1.0`
- port: `4807`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `POSTHOG_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
POSTHOG_API_KEY=phc_parlel
POSTHOG_PERSONAL_API_KEY=phx_parlel
POSTHOG_HOST=http://localhost:4807
POSTHOG_BASE_URL=http://localhost:4807
```

<!-- parlel:testenv:end -->
