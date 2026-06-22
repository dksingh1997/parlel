# Contributing

Thanks for helping grow Parlel. The most valuable contribution is **adding a new
service emulator** — here's how, in about five minutes.

## Add a service

A service lives in `services/<slug>/` and needs three things:

### 1. `services/<slug>/manifest.json`

```json
{
  "name": "myservice",
  "port": 4900,
  "protocol": "http",
  "healthcheck": "/health",
  "env_vars": {
    "MYSERVICE_API_KEY": "parlel",
    "MYSERVICE_BASE_URL": "http://localhost:4900"
  }
}
```

- `port` — pick a free one (grep `.env.example` to avoid clashes).
- `protocol` — `http` for REST services, `tcp` for wire-protocol databases.
- `env_vars` — seeded test credentials + the base URL. These become the
  service's entry in `.env.example`.

### 2. `services/<slug>/src/server.js`

Export a class named `<Something>Server` implementing the **emulator contract**:

- `constructor(port, options)` — store config; call `this.reset()`. No I/O here.
- `start()` — returns a promise that resolves once listening.
- `stop()` — returns a promise that resolves once closed.
- `reset()` — clears **all** in-memory state back to empty. Idempotent, no I/O.

`reset()` is required: it gives every test a clean slate and is what the Parlel
control plane calls between test cases. Initialize all state inside `reset()` and
call it from the constructor so the two never drift. The conformance test
(`test/conformance.test.ts`) enforces this contract across the whole catalog.

```js
import { createServer } from "node:http";

export class MyServiceServer {
  constructor(port = 4900) {
    this.port = port;
    this.server = null;
    this.reset();
  }

  // Clears all in-memory state back to empty. Idempotent, no I/O.
  reset() {
    this.things = new Map();
    this.counter = 0;
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ status: "ok" }));
        }
        // ... implement the real API contract here ...
        res.writeHead(404);
        res.end();
      });
      this.server.listen(this.port, () => resolve());
    });
  }

  stop() {
    return new Promise((r) => (this.server ? this.server.close(r) : r()));
  }
}
```

**Keep it dependency-free** — the emulators run with plain Node, no npm install.
Implement the *real* wire protocol / REST contract so unmodified client
libraries work against it. That fidelity is the whole point.

### 3. `test/<slug>.test.ts`

Add a vitest that drives the emulator with the **real client library** and
asserts a round-trip. Use `getFreePort` from `src/test-helpers.js` so tests
don't collide.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MyServiceServer } from "../services/myservice/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

let server: MyServiceServer;
let port: number;

beforeAll(async () => {
  port = await getFreePort();
  server = new MyServiceServer(port);
  await server.start();
});
afterAll(() => server.stop());

it("responds to health", async () => {
  const res = await fetch(`http://localhost:${port}/health`);
  expect(res.status).toBe(200);
});
```

## Verify

```bash
npm install
npm test                                  # runs the suite
SERVICES=myservice node src/launch.mjs    # boot just your service
npm run probe                             # health-check
```

## PR checklist

- [ ] `manifest.json`, `src/server.js`, `test/<slug>.test.ts` added.
- [ ] `*Server` implements the contract: `constructor(port, options)`, `start()`,
      `stop()`, `reset()` (all state initialized in `reset()`).
- [ ] No new runtime dependencies (emulators stay pure Node).
- [ ] Port doesn't clash with an existing service.
- [ ] `npm test` passes (including `test/conformance.test.ts`).
- [ ] Real client library round-trips against the emulator.

## Code of conduct

Be kind. Assume good faith. Keep it technical.
