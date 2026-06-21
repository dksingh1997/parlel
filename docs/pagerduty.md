# PagerDuty

Lightweight, dependency-free, in-memory PagerDuty REST API v2 + Events API v2 fake for testing code that uses the `@pagerduty/pdjs` client or the raw PagerDuty APIs.

Default port: `4774`

## Quick start

```js
import { PagerdutyServer } from "./services/pagerduty/src/server.js";

const server = new PagerdutyServer(4774);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Call the REST API (`Token` auth) or the Events API (`routing_key`):

```js
// REST API
await fetch("http://127.0.0.1:4774/incidents", {
  headers: {
    Authorization: "Token token=pd_parlel",
    Accept: "application/vnd.pagerduty+json;version=2",
  },
});

// Events API v2
await fetch("http://127.0.0.1:4774/v2/enqueue", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    routing_key: "parlelroutingkey0000000000000000",
    event_action: "trigger",
    payload: { summary: "boom", source: "host1", severity: "critical" },
  }),
});
// => { status: "success", dedup_key: "..." }
```

## Access via MCP / preview URL

- REST base URL: `http://127.0.0.1:4774`
- Events API: `http://127.0.0.1:4774/v2/enqueue`
- Set `PAGERDUTY_TOKEN=pd_parlel`, `PAGERDUTY_API_URL=http://127.0.0.1:4774`, and `PAGERDUTY_ROUTING_KEY=parlelroutingkey0000000000000000`.

REST API auth: `Authorization: Token token=<key>` (also accepts `Bearer`). Set `Accept: application/vnd.pagerduty+json;version=2`. The Events API authenticates with `routing_key` in the body.

## Implemented operations

State is in-memory and ephemeral; enqueued events are captured.

- `GET /incidents` — list incidents.
- `POST /incidents` — create incident (requires `incident.title`); returns `triggered`.
- `GET /incidents/:id` — retrieve / `PUT` update (`status`, `title`).
- `GET /services` — list / `POST` create (requires `service.name`).
- `GET /services/:id` — retrieve.
- `GET /users` — list / `POST` create (requires `user.name`, `user.email`).
- `GET /users/:id` — retrieve.
- `POST /v2/enqueue` — Events API v2; requires `routing_key` and `event_action`. Returns `202 { status: "success", dedup_key }`.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/events` — list captured Events-API events (`{ events, count }`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Incidents list / create / get / update | ✅ Supported |
| Services list / create / get | ✅ Supported |
| Users list / create / get | ✅ Supported |
| Events API v2 `/v2/enqueue` | ✅ Supported (captured) |
| `Token token=` / `Bearer` auth | ✅ Required on REST API |
| Escalation policies / schedules / notifications | ⟳ Roadmap |
| Real paging / alerting / on-call routing | ✓ By design — Events captured, never delivered |
| `more`/`offset` pagination | ◐ Single page (`more: false`) |

## Error codes & shapes

REST error envelope: `{ "error": { "message": "...", "code": 2001, "errors": [...] } }`. Events API uses `{ status, message, errors }`.

| Status | When |
| --- | --- |
| `401` | REST API without `Token`/`Bearer` |
| `400` | missing required field / invalid event |
| `404` | unknown resource |
| `405` | method not allowed |

## Manifest

See `services/pagerduty/manifest.json`:

- name: `pagerduty`, image: `parlel/pagerduty:1`
- port: `4774`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `PAGERDUTY_TOKEN`, `PAGERDUTY_API_URL`, `PAGERDUTY_ROUTING_KEY`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PAGERDUTY_TOKEN=pd_parlel
PAGERDUTY_API_URL=http://localhost:4774
PAGERDUTY_ROUTING_KEY=parlelroutingkey0000000000000000
```

<!-- parlel:testenv:end -->
