# Opsgenie

Lightweight, dependency-free, in-memory fake of the **Opsgenie Alert API v2** for testing incident/alerting code. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4880`

## Quick start

```js
import { OpsgenieServer } from "./services/opsgenie/src/server.js";

const server = new OpsgenieServer(4880);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with the Opsgenie scheme `Authorization: GenieKey <key>` (any non-empty key accepted):

```bash
curl -H "Authorization: GenieKey parlel" http://127.0.0.1:4880/v2/alerts
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `OPSGENIE_API_KEY=parlel` and `OPSGENIE_BASE_URL=http://127.0.0.1:4880`, then drive the Alert API v2. The MCP server proxies the endpoints below so an agent can create and triage alerts without a real Opsgenie account.

## Implemented operations

All `/v2/*` routes require an `Authorization: GenieKey <key>` header (any non-empty key accepted). List responses use the `{ data: [], paging: {}, took, requestId }` envelope; async actions return `202 { result: "Request will be processed", took, requestId }`.

- `POST /v2/alerts` — create an alert → `202 { result, took, requestId }`. Requires `message` (else `422`).
- `GET /v2/alerts` — list alerts.
- `GET /v2/alerts/:id` — retrieve an alert by `id`, `tinyId`, or `alias` (`{ data, took, requestId }`).
- `POST /v2/alerts/:id/acknowledge` — acknowledge → `202`.
- `POST /v2/alerts/:id/close` — close → `202`.
- `GET /v2/heartbeats` — list heartbeats (a default heartbeat is seeded).

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
| Alert create/list/get, acknowledge, close | ✅ Supported |
| Lookup by `id` / `tinyId` / `alias` | ✅ Supported |
| Heartbeat list | ✅ Supported |
| Async request-status polling (`/v2/alerts/requests/:id`) | ⟳ Roadmap — Actions applied synchronously |
| Notes / tags / attachments / escalations / responders routing | ◐ Stored on create, no dedicated endpoints |
| Real notification delivery (SMS / phone / email) | ⟳ Roadmap — Intentionally unsupported |
| Schedules / teams / integrations / policies | ⟳ Roadmap |

## Manifest

See `services/opsgenie/manifest.json`:

- name: `opsgenie`, port: `4880`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `OPSGENIE_API_KEY`, `OPSGENIE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
OPSGENIE_API_KEY=parlel
OPSGENIE_BASE_URL=http://localhost:4880
```

<!-- parlel:testenv:end -->
