# SKILL: Implementing in Parlel

This is the operating manual for any agent writing code in the Parlel repo. Follow
it end to end: **plan → implement → test → docs → changelog → hygiene**. Treat code
and docs as a single deliverable — a change that updates code without updating its
docs is incomplete.

Parlel is a collection of **250+ zero-dependency service emulators** that speak
**real wire protocols / REST contracts**, so unmodified production drivers connect
directly. Fidelity is the entire point. Everything below protects that.

---

## 0. Non-negotiable invariants

Violating any of these fails the change.

1. **No runtime dependencies in emulators.** `services/**/src/*.js` use **Node
   built-ins only** (`node:http`, `node:net`, `node:fs`, `node:crypto`, …). No
   `npm install` is ever required to run an emulator. New deps may only be added to
   `devDependencies`, and only when they are a **real client library used to verify
   fidelity in a test** (e.g. `pg`, `stripe`, an AWS SDK client).
2. **Production drivers connect unmodified.** Never change the emulated protocol to
   make implementation easier. The contract is what the real SDK expects. Any admin
   surface is *additive* and namespaced (see `__parlel` below), never a protocol change.
3. **Ephemeral by default.** State lives in memory and resets to empty on restart.
   No disk persistence, no network egress — "no data ever leaves the machine."
4. **ES Modules.** `"type": "module"`. Use `import`/`export`, never `require`.
5. **Fast.** Per-service startup stays sub-second. No heavy work in the constructor
   beyond `this.reset()`.
6. **Match the existing conventions** in neighboring services. When unsure, read a
   similar service (`services/stripe`, `services/s3`, `services/openai`) and copy
   its shape. Consistency across 130k+ lines matters more than personal taste.

---

## 1. PLAN (before writing any code)

Do not skip this. Write the plan into the task/PR description.

1. **Identify the kind of change:**
   - **New service emulator** → follow §2 (the common case).
   - **Extend an existing emulator** (more routes/fidelity) → §3.
   - **Tooling/control-plane/launcher change** (`src/`, `scripts/`) → §4.
2. **Research the real contract.** For a service, find the authoritative API: real
   endpoints, auth scheme, request/response shapes, error envelope, pagination,
   content types. Use Context7 / official docs. The emulator must mirror this — a
   plausible-looking fake that the real SDK rejects is a bug.
3. **Pick the verifying client.** Decide which **real client library** the test will
   drive the emulator with. If it's already in `devDependencies`, good. If not,
   adding it must be justified (it is the only way to prove fidelity).
4. **Reserve a port.** Grep `.env.example` and `services/*/manifest.json` to pick a
   **free, unused port**. Document it.
5. **Scope the surface.** List the operations you will implement now vs. intentionally
   return `501 Not Implemented` for. Document the boundary — unimplemented-on-purpose
   is fine and must be stated; silent gaps are not.
6. **State the acceptance check:** "real client `X` does round-trip `Y` and asserts `Z`;
   `npm test` passes; `npm run probe` shows the service green."

---

## 2. IMPLEMENT — a new service emulator

A service lives in `services/<slug>/` and is exactly three files:
`manifest.json`, `src/server.js`, and `test/<slug>.test.ts`.

### 2.1 `services/<slug>/manifest.json`

```json
{
  "name": "<slug>",
  "version": "1.0",
  "port": 4900,
  "protocol": "http",
  "category": "<category>",
  "healthcheck": "/health",
  "env_vars": {
    "<SVC>_API_KEY": "parlel",
    "<SVC>_BASE_URL": "http://127.0.0.1:4900"
  }
}
```

- `protocol`: `http`/`https` for REST, `tcp` for wire-protocol databases,
  `embedded` for no-network (e.g. sqlite).
- `port` must be unique across the repo. **Do not use `4600`** — that's the
  control-plane default.
- `category`: groups the service for `parlel ls <category>` (e.g. `payments`,
  `ai`, `databases`, `aws`). Required — the conformance test enforces it.
- `env_vars` are seeded test credentials + base URL; these mirror `.env.example`.

### 2.2 `services/<slug>/src/server.js` — the emulator contract

Export a class named `<Name>Server`. The launcher discovers it via the regex
`/Server$/` (`src/launch.mjs`), so the suffix is required. Implement this exact
contract — it is what the launcher, probe, and control plane rely on:

```js
import { createServer } from "node:http";

export class MyServiceServer {
  // REQUIRED. Signature is (port, options). Do init via this.reset().
  constructor(port = 4900, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  // REQUIRED by convention. Clears ALL in-memory state back to empty.
  // Used for per-test isolation. Idempotent. No I/O.
  reset() {
    this.things = new Map();
    this.counter = 0;
  }

  // REQUIRED. Resolves once listening; rejects on bind error.
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch(() =>
          this.send(res, 500, { error: "internal" }),
        );
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  // REQUIRED. Resolves once closed; safe to call when not started.
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => {
        this.server = null;
        err ? reject(err) : resolve();
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    // Health check — every service answers this (probe.mjs hits it).
    if (req.method === "GET" && url.pathname === "/health")
      return this.send(res, 200, { status: "ok" });
    // Parlel control plane — namespaced, additive, never part of the real API.
    if (url.pathname.startsWith("/__parlel"))
      return this.handleControl(req, res, url);
    // ... implement the REAL API contract here ...
    this.send(res, 404, { error: "not found" });
  }

  // REQUIRED by convention: the additive admin surface.
  handleControl(req, res, url) {
    if (req.method === "POST" && url.pathname === "/__parlel/reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: "not found" });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }
}
```

**The control-plane convention is established and mandatory for new HTTP services:**
- A `reset()` method that returns state to empty.
- A `POST /__parlel/reset` endpoint (routed via `handleControl`) that calls it.
- A `GET /health` endpoint returning `200`.

This is what makes the emulator usable inside a test suite (clean slate per test).
Look at `services/stripe/src/server.js` for the canonical reference.

**Fidelity rules:**
- Mirror the **real** request parsing (Stripe is form-encoded with bracket
  notation; AWS is often `x-amz-json`; many are JSON). Parse what the real SDK sends.
- Mirror the **real** response shape **and error envelope** exactly — wrong error
  format is the #1 reason a real SDK breaks.
- Mirror auth behavior (usually: accept any non-empty token matching the scheme).
- Mirror pagination, content-type headers, and CORS where the SDK depends on them.
- For complex protocols, split into multiple files (see `services/postgres/`,
  `services/mongodb/`) — but keep the exported `*Server` class as the entry point.

### 2.3 Wiring

- Add the service's `env_vars` (port + seeded creds) to **`.env.example`**.
- `docker-compose.yml` publishes canonical ports — add the port mapping if your
  service should be reachable in raw compose mode (match the existing format).
- TCP services need a real-driver round-trip case in `scripts/probe.mjs` if they
  use a native driver; HTTP services are probed automatically via `/health`.

---

## 3. IMPLEMENT — extending an existing emulator

- Read the whole `server.js` (and `docs/<slug>.md`) first; match its helpers,
  error-envelope function, id-generation, and routing style.
- Add new routes alongside existing ones; do not refactor unrelated code.
- Anything new you implement must be reflected in `reset()` (so test isolation
  still wipes it) and in `docs/<slug>.md`.

---

## 4. IMPLEMENT — tooling / launcher / scripts

Files: `src/fleet.mjs` (the shared start/stop/control-plane/recorder/fixtures
engine), `src/launch.mjs` (thin wrapper over `Fleet`), `src/cli.mjs` (the
`parlel` CLI), `src/control-plane.mjs`, `src/request-recorder.mjs`,
`src/mcp.mjs` (the MCP server), `src/test-helpers.js`, `scripts/up.mjs`,
`scripts/probe.mjs`. Same rule: **Node built-ins only.** These orchestrate the
emulators and must stay dependency-free and fast.

- The launcher and the MCP server both go through **`Fleet`** — add fleet-level
  behavior there once, not in each entry point.
- The MCP server writes JSON-RPC to **stdout only**; all its logging goes to
  stderr. Never `console.log` from MCP code paths.
- If you add a new control-plane capability, define the emulator-side contract (a
  method + a `/__parlel/*` route) and document it here in this skill so future
  services implement it from day one.

---

## 5. TEST (mandatory — fidelity is proven, not claimed)

Every change ships with a test in `test/<slug>.test.ts` (Vitest, TypeScript).

- **Drive the emulator with the REAL client library**, not raw fetch where an SDK
  exists. The point is to prove the real driver works unmodified.
- Use `getFreePort()` from `src/test-helpers.js` for the port — never hardcode.
  Tests must not collide.
- `beforeAll` starts the server; `afterAll` stops it. Reset state between cases
  (`beforeEach` calling the instance's `reset()` or `POST /__parlel/reset`) when
  tests share an instance.
- Assert **real round-trips**: create → read back → assert shape/values, list +
  pagination, and at least one **error path** (the error envelope is fidelity-critical).

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

it("round-trips with the real client", async () => {
  // ... use the real SDK pointed at http://localhost:${port}, assert the result
});
```

**Run before declaring done:**

```bash
npm test                                  # full vitest suite (sequential by design)
SERVICES=<slug> node src/launch.mjs       # boot just your service
npm run probe                             # health-check; must show your service green
```

> Note: `vitest.config.ts` sets `fileParallelism: false` because each emulator binds
> a fixed port — do not "fix" this by enabling parallelism.

---

## 6. DOCS (code and docs go hand in hand — not optional)

A change is **incomplete** until its documentation matches. For every change:

1. **`docs/<slug>.md`** — the per-service API reference. New/changed service →
   create/update it. Required sections (follow `docs/stripe.md` as the template):
   - Title + one-line description (dependency-free, in-memory, real-SDK-compatible).
   - **Default port.**
   - **Quick start**: starting the server + pointing the real client at it (with a
     real code snippet).
   - **Implemented operations**: every route, its response shape, auth, pagination.
   - **Intentionally not implemented**: list what returns `501`/`405` on purpose.
3. **`README.md`** — update the "What's included" category table counts/examples if
   you added a service. Update the roadmap if you delivered a roadmap item.
4. **`.env.example`** — the service's port + seeded creds (must already be done in §2.3).
5. **`CONTRIBUTING.md`** — only if you changed the contributor workflow or the
   emulator contract.
6. **This `SKILL.md`** — if you changed a repo-wide convention (e.g. the control-plane
   contract), update it here so future agents inherit the new rule.

**Consistency check:** the routes documented in `docs/<slug>.md` must exactly match
the routes implemented in `server.js`. If they drift, the docs are wrong.

---

## 7. CHANGELOG

Maintain `CHANGELOG.md` at the repo root ([Keep a Changelog](https://keepachangelog.com)
format, newest first). If it does not exist yet, create it with an `## [Unreleased]`
section. For every change add an entry under the right heading:

```markdown
# Changelog

## [Unreleased]

### Added
- `<slug>` emulator on port `4900` — implements customers, charges, and webhooks;
  verified against the real `<sdk>` client.

### Changed
- ...

### Fixed
- ...
```

Bump the `version` in `package.json` only when explicitly cutting a release;
otherwise accumulate under `[Unreleased]`. Keep entries user-facing (what a dev
gains), not internal mechanics.

---

## 8. CODE HYGIENE

- **Style:** match the surrounding file — 2-space indent, ES modules, small focused
  methods, helper functions at module scope (see how `stripe/src/server.js` factors
  `stripeError`, `parseFormEncoded`, `token`).
- **No dead code, no commented-out blocks, no `console.log` left in emulators.**
  The launcher owns logging.
- **Names** describe the real API concept (`customers`, `charges`), not generic
  (`data`, `items`).
- **Errors** never crash the server: the top-level `handle().catch()` must return a
  well-formed error response in the service's real error envelope.
- **Idempotent `reset()`**, **no shared mutable module state** between instances
  (state lives on `this`), so multiple instances on different ports stay isolated.
- **Comment the "why," not the "what"** — especially any deliberate deviation or
  `501` boundary, so it isn't mistaken for a bug later.
- **Self-review the diff** before finishing: only intended files changed, no secrets,
  no stray formatting churn in untouched code.

---

## 9. Definition of Done — final checklist

- [ ] **Plan** written (kind of change, real contract researched, port reserved, scope stated).
- [ ] `manifest.json` (unique port, correct protocol/healthcheck/env_vars).
- [ ] `src/server.js` exporting `*Server` with `constructor(port, options)`,
      `reset()`, `start()`, `stop()`, `GET /health`, and `POST /__parlel/reset`.
- [ ] **Node built-ins only** in the emulator; no new runtime deps.
- [ ] Real production driver connects **unmodified** and round-trips.
- [ ] `test/<slug>.test.ts` drives the **real client**, uses `getFreePort()`, covers
      create/read/list/pagination and at least one error path.
- [ ] `npm test` passes (incl. `test/conformance.test.ts`); `npm run probe` shows the service green.
- [ ] `docs/<slug>.md` created/updated and **matches the implemented routes**.
- [ ] `.env.example`, `README.md` table (and `docker-compose.yml` ports if applicable) updated.
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`.
- [ ] Diff is clean: no dead code, no `console.log`, no unrelated churn, no secrets.
- [ ] If a repo-wide convention changed, **this SKILL.md was updated** too.
