# Calendly

Lightweight, dependency-free, in-memory Calendly API v2 fake for testing code that uses the Calendly REST API (the language-agnostic v2 surface).

Default port: `4813`

## Quick start

```js
import { CalendlyServer } from "./services/calendly/src/server.js";

const server = new CalendlyServer(4813);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your client's base URL at it:

```js
const res = await fetch("http://127.0.0.1:4813/users/me", {
  headers: { Authorization: "Bearer parlel" },
});
const { resource } = await res.json();
```

State is in-memory and ephemeral.

## Implemented operations

All routes require `Authorization: Bearer <token>`; any non-empty bearer token is accepted. Single resources are wrapped in `{ resource }`; collections in `{ collection, pagination }`.

### Users & event types

- `GET /users/me` — current user (`{ resource }`).
- `GET /users/:uuid` — a user by uuid.
- `GET /event_types?user=` — list event types (`{ collection, pagination }`).
- `GET /event_types/:uuid` — retrieve an event type.

### Scheduled events

- `GET /scheduled_events` — list scheduled events (`{ collection, pagination }`).
- `POST /scheduled_events` — create a scheduled event (`201 { resource }`).
- `GET /scheduled_events/:uuid` — retrieve a scheduled event.

### Scheduling links

- `POST /scheduling_links` — create a single-use scheduling link (`201 { resource: { booking_url, owner, owner_type } }`). Requires `owner`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state (re-seeds the default event type).
- `GET /__parlel/scheduled_events` — list scheduled events.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); point your client's base URL at it. Through the parlel MCP server, the users/event-types/scheduled-events routes are exposed as a tool surface so an AI agent can create and inspect scheduling state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /users/me` (+ `/users/:uuid`) | ✅ Supported |
| Event types list/get | ✅ Supported |
| Scheduled events list/create/get | ✅ Supported |
| Scheduling links create | ✅ Supported |
| Invitees / cancellations / no-shows | ⟳ Roadmap |
| Webhooks / Organizations / Memberships | ⟳ Roadmap |
| Real availability computation | ✓ By design — Not computed (events are seeded/created directly) |
| Bearer-token validity check | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/calendly/manifest.json`:

- name: `calendly`, image: `parlel/calendly:1.0`
- port: `4813`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CALENDLY_TOKEN`, `CALENDLY_API_KEY`, `CALENDLY_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CALENDLY_TOKEN=parlel
CALENDLY_API_KEY=parlel
CALENDLY_HOST=http://localhost:4813
CALENDLY_BASE_URL=http://localhost:4813
```

<!-- parlel:testenv:end -->
