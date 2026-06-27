# Control plane

Parlel runs a single **control-plane** admin server alongside the emulators
(default `localhost:4600`). It is **additive** — it never touches the emulated
wire protocols. It only introspects and controls the in-memory emulator instances
the launcher started, through the emulator contract (`reset()`, optional `dump()`).

This is what makes Parlel usable **inside a test suite**: reset every service to a
clean slate between test cases without restarting containers.

```
your app / agent ──▶ localhost:<port>  ──▶ emulator (real protocol)
your test harness ──▶ localhost:4600   ──▶ control plane (admin: list / reset / state)
```

## Configuration

- **`PARLEL_CONTROL_PORT`** — control-plane port (default `4600`).
- **`PARLEL_CONTROL=0`** — disable the control plane entirely.
- **`PARLEL_RECORD=0`** — disable the request recorder.
- **`PARLEL_RECORD_CAP`** — requests kept per service (default `1000`).
- **`PARLEL_RECORD_MAX_BODY`** — max captured body bytes (default `65536`).

If the control port is already in use, the launcher logs it and continues without
the admin API — the emulators still run.

## Dashboard

Open `http://localhost:4600/` **in a browser** for a live dashboard: a grid of
every running service (slug, port, protocol, uptime, capability badges, and a
copy-ready connection string), a request-log viewer, a state inspector, and
per-service + whole-fleet **Reset** buttons. It auto-refreshes every 2 seconds.

The page is a single self-contained HTML file (vanilla JS, no build step, no CDN,
no dependencies) served by the control plane. It is a pure client of the JSON API
below — it adds no new server behavior.

Content negotiation on `GET /`: browsers (`Accept: text/html`) get the dashboard;
programmatic clients (`fetch`/curl/SDKs, which send `Accept: */*`) get the JSON
index. Use `GET /api` to force JSON.

## Endpoints

### `GET /`
The HTML dashboard for browsers; the JSON API index for programmatic clients
(see content negotiation above). `GET /api` always returns JSON — name, service
count, and the endpoint list.

### `GET /healthz`
Aggregate fleet health.

```json
{ "status": "ok", "count": 3,
  "services": [{ "slug": "stripe", "port": 4757, "protocol": "http" }] }
```

### `GET /services`
List every registered service with metadata.

```json
{ "services": [{
  "slug": "stripe", "name": "stripe", "port": 4757, "protocol": "http",
  "uptime_ms": 3941,
  "supports": { "reset": true, "dump": false, "seed": false },
  "connection_string": "http://127.0.0.1:4757"
}] }
```

### `GET /services/:slug`
Detail for one service (same shape as a `/services` entry). `404` if unknown.

The `connection_string` is the source of truth for how to reach a service — handy
because `npm run up` may remap a busy port. Known protocols (postgres, mysql,
redis, mongodb, rabbitmq) return a ready-to-use URL.

### `GET /services/:slug/state`
Dump the service's in-memory state. Returns `501 not supported` if the emulator
does not implement `dump()`. Maps/Sets are serialized to plain JSON.

### `GET /services/:slug/requests`
The **request log** — every HTTP request the emulator received, captured by the
universal recorder (no emulator code involved). `501 not supported` for TCP
services or when recording is disabled. Filters via query params:

- `method` — e.g. `POST`
- `path` — exact or prefix match, e.g. `/v1/charges`
- `since` — ms epoch; only requests at/after this time
- `limit` — return at most N (newest)

```json
{ "slug": "stripe", "count": 1, "requests": [{
  "seq": 1, "ts": 1782153233000, "method": "POST", "path": "/v1/customers",
  "query": {}, "headers": { "authorization": "[redacted]" },
  "requestBody": "email=a%40b.com", "requestBytes": 16,
  "status": 200, "responseBody": "{\"id\":\"cus_...\"}", "durationMs": 0.42
}] }
```

`Authorization`, `Cookie`, `X-Api-Key`, and any `*secret*` header are redacted.
Bodies are capped (default 64 KB) and the buffer holds the last 1,000 requests
per service. Configure with `PARLEL_RECORD_CAP` / `PARLEL_RECORD_MAX_BODY`.
Disable recording entirely with `PARLEL_RECORD=0`.

This is the assertion primitive for tests:

```js
const { requests } = await (await fetch(
  "http://127.0.0.1:4600/services/stripe/requests?method=POST&path=/v1/charges",
)).json();
expect(requests).toHaveLength(1);
```

### `POST /services/:slug/reset`
Reset one service to a clean slate (also clears its request log). `501` if the
emulator has no `reset()`.

```json
{ "ok": true, "slug": "stripe" }
```

### `POST /services/:slug/seed`
Preload fixture data so a test can assume objects already exist (e.g. a customer
to charge). The JSON body is passed to the emulator's `seed()`. `501 not supported`
if the emulator has no `seed()`; `400` for invalid JSON.

```bash
curl -X POST localhost:4600/services/stripe/seed -H 'content-type: application/json' \
  -d '{"customers":[{"id":"cus_test","email":"a@b.com"}]}'
# -> { "ok": true, "slug": "stripe", "seeded": { "customers": 1, "products": 0, "prices": 0 } }
```

Seeded objects are retrievable through the **real API surface** — e.g.
`GET /v1/customers/cus_test` on the Stripe emulator returns the seeded customer.

Per-service seed shapes:

- **stripe** — `{ customers: [...], products: [...], prices: [...] }`. Each entry
  may include its own `id`; otherwise one is generated.
- **redis** — `{ "key": "value", ... }` or `{ keys: { "key": "value" } }` (string keys).

### `POST /reset`
Reset the **entire fleet** at once — the per-test isolation primitive.

```json
{ "ok": true, "reset": ["stripe", "redis"], "skipped": [], "failed": [] }
```

## Fixtures on boot

Drop a `parlel.fixtures.json` in your working directory (or point at one with
`PARLEL_FIXTURES`). The launcher loads it after services start and calls each
service's `seed()`:

```json
{
  "stripe": { "customers": [{ "id": "cus_test", "email": "a@b.com" }] },
  "redis":  { "session:abc": "user-1" }
}
```

Services without a `seed()` (or not currently running) are skipped with a log
line — never fatal.

## Using it in tests

```js
// Reset every service before each test — clean slate, no container restart.
beforeEach(async () => {
  await fetch("http://127.0.0.1:4600/reset", { method: "POST" });
});
```

## Notes

- Pure Node, zero dependencies — same rule as the emulators.
- `reset()`/`dump()` are introspected per service; missing methods degrade
  gracefully (`supports` flags + `501` responses) rather than erroring.
