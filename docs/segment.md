# Segment

Lightweight, dependency-free, in-memory Segment Tracking API fake for testing code that uses the real `@segment/analytics-node` SDK (and the language-agnostic Segment HTTP Tracking API).

Default port: `4815`

## Quick start

```js
import { SegmentServer } from "./services/segment/src/server.js";

const server = new SegmentServer(4815);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@segment/analytics-node` client at it via `host`:

```js
import { Analytics } from "@segment/analytics-node";

const analytics = new Analytics({ writeKey: "parlel", host: "http://127.0.0.1:4815" });
analytics.track({ userId: "user-1", event: "Order Completed", properties: { total: 99 } });
await analytics.closeAndFlush();
```

State is in-memory and ephemeral.

## Implemented operations

Authentication is via HTTP Basic with the write key as the username (Bearer is also accepted). Every call returns `200 {}`, matching Segment.

### Tracking

- `POST /v1/track` — record a track call.
- `POST /v1/identify` — record an identify call (`traits`).
- `POST /v1/page` — record a page call.
- `POST /v1/group` — record a group call (`groupId`, `traits`).
- `POST /v1/batch` — submit a batch of typed messages (`{ batch: [{ type, ... }] }`).

All captured events are normalized with `{ messageId, type, userId, anonymousId, event, name, groupId, properties, traits, context, timestamp }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state.
- `GET /__parlel/events` — list every captured event (`{ events, count }`).
- `DELETE /__parlel/events` — clear captured events.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); set the SDK's `host` to that URL. Through the parlel MCP server, the tracking routes are exposed as a tool surface so an AI agent can emit track/identify/page/group calls and inspect what was captured.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `track` / `identify` / `page` / `group` | ✅ Supported |
| `batch` (mixed typed messages) | ✅ Supported |
| `200 {}` response semantics | ✅ Supported |
| Captured-event inspection | ✅ Supported (parlel extension) |
| `alias` / `screen` | ◐ Accepted/captured, not specially modeled |
| Destinations / fan-out to downstream tools | ⟳ Roadmap — capture only |
| Config API / Sources / Tracking Plans | ⟳ Roadmap |
| Write-key validity check | ◐ Any Basic/Bearer credentials accepted |

## Manifest

See `services/segment/manifest.json`:

- name: `segment`, image: `parlel/segment:1.0`
- port: `4815`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SEGMENT_WRITE_KEY`, `SEGMENT_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SEGMENT_WRITE_KEY=parlel
SEGMENT_HOST=http://localhost:4815
SEGMENT_BASE_URL=http://localhost:4815
```

<!-- parlel:testenv:end -->
