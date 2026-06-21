# Cal.com

Lightweight, dependency-free, in-memory Cal.com API v2 (and v1-style) fake for testing scheduling code.

Default port: `4849`

## Quick start

```js
import { CalComServer } from "./services/cal-com/src/server.js";

const server = new CalComServer(4849);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a Cal.com client at `http://127.0.0.1:4849`. Authenticate with a Bearer

accepted):

```js
const res = await fetch("http://127.0.0.1:4849/v2/me", {
  headers: { Authorization: "Bearer cal_parlel" },
});
const { status, data } = await res.json();
```

## Response shape

v2 responses use:

```json
{ "status": "success", "data": ... }
```

## Implemented operations

`/v2/*` and `/v1/*` routes require auth. State is in-memory.

- `GET /v2/me` — the authenticated user.
- `GET /v2/event-types` — list event types (`data.eventTypes` and `data.eventTypeGroups`).
- `GET /v2/slots` — available slots keyed by day (`?eventTypeId=&start=&end=`).
- `GET /v2/bookings` — list bookings.
- `POST /v2/bookings` — create a booking (`201`).
- `GET /v2/bookings/:uid` — retrieve a booking.
- `PATCH /v2/bookings/:uid` — reschedule (update `start`/`end`).
- `POST /v2/bookings/:uid/cancel` — cancel a booking (`status: "cancelled"`).

The same routes are reachable under `/v1/...` for v1-style clients using `?apiKey=`.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `CAL_COM_BASE_URL` (`http://127.0.0.1:4849`). When
running in the parlel pool, an MCP tool / preview URL proxies to this base URL —
point your Cal.com client at that URL with a Bearer `cal_` key (or `?apiKey=`)
and every endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /v2/me` | ✅ Supported |
| Event types listing | ✅ Supported |
| Slots | ✅ Supported (deterministic 3 slots/day) |
| Bookings list/create/get/cancel/reschedule | ✅ Supported |
| Bearer `cal_` key **and** `?apiKey=` (v1) | ✅ Supported |
| `{status:'success', data}` v2 shape | ✅ Supported |
| OAuth / managed users / webhooks | ⟳ Roadmap |
| Real availability computation | ◐ Static slots |
| API-key validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ status: "error", error: { code, message } }`:

| Status | When |
| --- | --- |
| `401` | missing Bearer key and `?apiKey=` |
| `404` | unknown booking or endpoint |

## Manifest

See `services/cal-com/manifest.json`:

- name: `cal-com`, port: `4849`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CAL_COM_API_KEY`, `CAL_COM_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CAL_COM_API_KEY=cal_parlel
CAL_COM_BASE_URL=http://localhost:4849
```

<!-- parlel:testenv:end -->
