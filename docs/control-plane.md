# Control plane

Parlel runs a single **control-plane** admin server alongside the emulators
(default `localhost:4700`). It is **additive** — it never touches the emulated
wire protocols. It only introspects and controls the in-memory emulator instances
the launcher started, through the emulator contract (`reset()`, optional `dump()`).

This is what makes Parlel usable **inside a test suite**: reset every service to a
clean slate between test cases without restarting containers.

```
your app / agent ──▶ localhost:<port>  ──▶ emulator (real protocol)
your test harness ──▶ localhost:4700   ──▶ control plane (admin: list / reset / state)
```

## Configuration

- **`PARLEL_CONTROL_PORT`** — control-plane port (default `4700`).
- **`PARLEL_CONTROL=0`** — disable the control plane entirely.

If the control port is already in use, the launcher logs it and continues without
the admin API — the emulators still run.

## Endpoints

### `GET /`
Index — name, service count, and the endpoint list.

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

### `POST /services/:slug/reset`
Reset one service to a clean slate. `501` if the emulator has no `reset()`.

```json
{ "ok": true, "slug": "stripe" }
```

### `POST /reset`
Reset the **entire fleet** at once — the per-test isolation primitive.

```json
{ "ok": true, "reset": ["stripe", "redis"], "skipped": [], "failed": [] }
```

## Using it in tests

```js
// Reset every service before each test — clean slate, no container restart.
beforeEach(async () => {
  await fetch("http://127.0.0.1:4700/reset", { method: "POST" });
});
```

## Notes

- Pure Node, zero dependencies — same rule as the emulators.
- `reset()`/`dump()` are introspected per service; missing methods degrade
  gracefully (`supports` flags + `501` responses) rather than erroring.
