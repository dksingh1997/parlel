# SKILL: Implementing in Parlel

This is the operating manual for any agent writing code in the Parlel repo. Follow
it end to end: **plan → implement → test → docs → changelog → hygiene → verify →
ship**. Treat code and docs as a single deliverable — a change that updates code
without updating its docs is incomplete.

Parlel is a collection of **250+ zero-dependency service emulators** that speak
**real wire protocols / REST contracts**, so unmodified production drivers connect
directly. Fidelity is the entire point. Everything below protects that.

**This document is a guardrail, not a guideline.** Its purpose is simple: *do not
push bugs into this repo.* Every rule here exists because skipping it has broken,
or would break, something real. When a rule and your instinct conflict, the rule
wins — or you stop and ask. If you cannot satisfy a gate, you are **not done**;
say so explicitly rather than shipping around it.

---

## The Iron Laws (read every time)

If you remember nothing else, remember these. Each one maps to a real failure
class (see §10, "Bugs we will not ship again").

1. **No fix ships without proof it works.** "Should work," "looks right," and "the
   logic is correct" are not proof. Proof = a test that fails before your change
   and passes after, plus the verification protocol in §9 run to green.
2. **Run the full suite 3× before you call it done.** Not once. Intermittent
   failures (port races, ordering) only show up across runs. One green run is not
   a green suite. (§9)
3. **Never break a passing test to make yours pass.** The suite is 5,500+ tests and
   was green before you touched it. If your change turns any test red, that is your
   bug, including "flaky" ones — fix the root cause, don't retry around it.
4. **Additive only at the boundary.** The emulated wire protocol and the public
   contract (`*Server` shape, control-plane routes, CLI flags, MCP tools) are
   promises. Extend them; do not change or remove them without updating every
   caller, test, and doc in the same change.
5. **Zero runtime dependencies. Node built-ins only.** In `services/**` *and* in
   `src/**` tooling. A new `import` of anything outside `node:*` (or a sibling
   local module) is a bug unless it is a dev-only test client.
6. **Reserve ports; never collide.** Every networked thing binds a port. Check it
   is free and unique *before* you use it. Port collisions have silently disabled
   services in this repo before.
7. **Code and docs are one commit.** If the routes, flags, tools, or behavior
   changed and the docs didn't, the change is incomplete and must not ship.
8. **Leave the diff clean.** Only the files you meant to change, no reformatting of
   untouched code, no stray `console.log`, no secrets, no commented-out blocks.

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
4. **Reserve a port — prove it's free.** Pick a port no other service uses, and
   that is not a reserved infra port. Run this and confirm your port is absent:

   ```bash
   # List every port already taken (services + control plane). Your port must NOT appear.
   node -e 'const fs=require("fs");for(const s of fs.readdirSync("services")){try{const m=JSON.parse(fs.readFileSync(`services/${s}/manifest.json`));if(m.port)console.log(m.port,s)}catch{}}' | sort -n | uniq -d
   node -e 'const fs=require("fs");const P=process.argv[1];for(const s of fs.readdirSync("services")){try{const m=JSON.parse(fs.readFileSync(`services/${s}/manifest.json`));if(m.port==P)console.log("TAKEN by",s)}catch{}}' <YOUR_PORT>
   ```

   **Reserved — never use:** `4600` (control-plane default). Avoid the `15000–16000`
   range (used by `up.mjs` for collision remaps). A duplicate port is caught by the
   conformance test, but a port that collides with an infra default (like the
   `4700`/ec2 incident) can silently disable a service — check both.
5. **Scope the surface.** List the operations you will implement now vs. intentionally
   return `501 Not Implemented` for. Document the boundary — unimplemented-on-purpose
   is fine and must be stated; silent gaps are not. **Do not ship a half-built
   feature as if it were whole** — if you implement `seed()` for 2 of 4 promised
   services, the docs and PR must say exactly which.
6. **State the acceptance check up front:** the literal command(s) and expected
   output that will prove the change works. E.g. "real client `X` does round-trip
   `Y` and asserts `Z`; `npm test` passes; `npm run probe` shows the service green."
   You will run these in §9 and paste the result.

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

Every change ships with a test in `test/<slug>.test.ts` (Vitest, TypeScript). A
change with no test is not done. A bug fix with no test that *fails before the
fix* is not a fix — it's a guess.

- **Drive the emulator with the REAL client library**, not raw fetch where an SDK
  exists. The point is to prove the real driver works unmodified.
- **Tests prove behavior, not the absence of crashes.** Assert concrete values
  (ids, fields, status codes, counts), not just `toBeTruthy()` / `not.toThrow()`.
- Assert **real round-trips**: create → read back → assert shape/values, list +
  pagination, and at least one **error path** (the error envelope is fidelity-critical).
- `beforeAll` starts the server; `afterAll` stops it. Reset state between cases
  (`beforeEach` calling the instance's `reset()` or `POST /__parlel/reset`) when
  tests share an instance.
- **Always clean up.** Every `start()` needs a matching `stop()`; every spawned
  process must be killed in `afterAll`. A test that leaks a listening server or a
  child process will break a *later* test file (the suite runs sequentially). Check
  for leaks: after a run, `pgrep -fl "src/launch.mjs|src/mcp.mjs"` must print nothing.

**Port handling — the #1 source of flake in this repo. Obey exactly:**
- Use `getFreePort()` from `src/test-helpers.js`. **Never hardcode a port.**
- `getFreePort()` finds a free port and releases it — a tiny race window exists
  before your server binds it. Under full-suite load that window gets hit. So if a
  test boots multiple servers, **allocate-and-bind one at a time with retry on
  `EADDRINUSE`**, never "reserve N ports up front, then start N servers":

  ```ts
  async function startOn<T extends { start(): Promise<void> }>(make: (p: number) => T) {
    for (let i = 0; i < 8; i++) {
      const port = await getFreePort();
      const server = make(port);
      try { await server.start(); return { server, port }; }
      catch (e: any) { if (e?.code === "EADDRINUSE") continue; throw e; }
    }
    throw new Error("could not bind a free port");
  }
  ```
- Do **not** "fix" a flaky port test by adding a `sleep`, widening a timeout, or
  catching-and-ignoring the error. Fix the race (retry pattern above) or the leak.

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

**Iterate fast, then verify hard.** While developing, run your file alone
(`npx vitest run test/<slug>.test.ts`). But "done" is defined by the full
verification protocol in **§9** — run it before you claim completion.

> Note: `vitest.config.ts` sets `fileParallelism: false` because each emulator binds
> a fixed port — do not "fix" this by enabling parallelism. If you think you need
> parallelism, you have a port-handling bug; fix that instead.

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

## 9. VERIFY — the gate you cannot skip

This is the difference between "I think it works" and "it works." Run all of it.
**Paste the results into your final summary.** If any step is red, you are not
done — fix it or report the blocker; never narrate around a failure.

### 9.1 Self-audit commands (run these, read the output)

```bash
# A. Syntax of every file you touched parses (no half-saved edits).
node --check src/<file>.mjs   # repeat per changed .mjs

# B. Zero-dependency law: no non-builtin imports in src/ or services/.
#    Expected output: nothing (any line printed = a forbidden dependency).
#    (Quote the globs so zsh doesn't expand them.)
grep -RnE "^\s*import .* from ['\"][^.]" src services --include="*.js" --include="*.mjs" | grep -v "from ['\"]node:"

# C. No stray debug logging you added (emulators + MCP must not console.log).
git diff -- services src | grep -nE "^\+.*console\.log"   # expected: nothing

# D. Every manifest is valid JSON and ports are unique.
node -e 'const fs=require("fs");const seen={};let bad=0;for(const s of fs.readdirSync("services")){try{const m=JSON.parse(fs.readFileSync(`services/${s}/manifest.json`));if(m.port){if(seen[m.port]){console.log("DUP PORT",m.port,s,seen[m.port]);bad++}seen[m.port]=s}}catch(e){console.log("BAD JSON",s);bad++}}console.log(bad?`${bad} problems`:"manifests OK")'

# E. The diff is only what you intended — review it.
git status --short
git diff --stat
```

### 9.2 The 3× full-suite rule (non-negotiable)

```bash
npm test   # run it THREE times, in a row. All three must be fully green.
```

- The suite runs sequentially (`fileParallelism: false`) and is timing-sensitive;
  **intermittent failures only surface across runs.** One green run proves nothing
  about flake. Three consecutive clean runs is the bar.
- If run 2 or 3 fails where run 1 passed, you have a real race or a leak (see §5
  port handling, and the cleanup rule). Fix the root cause, then restart the count
  from zero — three *consecutive* greens.
- After the runs, confirm nothing leaked:
  ```bash
  pgrep -fl "src/launch.mjs|src/mcp.mjs"   # expected: nothing
  ```

### 9.3 Live smoke (prove it works outside the test harness)

A test passing is necessary, not sufficient — exercise the real entry point too:

- **New/changed emulator:** `SERVICES=<slug> node src/launch.mjs &` then drive it
  with the real client / `curl`, then `npm run probe` shows it green.
- **CLI change:** run the actual command (`node src/cli.mjs <cmd>`), including a
  failure path.
- **MCP change:** drive it over stdio (initialize → tools/list → tools/call) — see
  `docs/mcp.md` for the one-liner.
- **Control-plane change:** boot a fleet, hit the endpoint with `curl`.

### 9.4 Definition of Done — final checklist

- [ ] **Plan** written (kind of change, real contract researched, **port proven
      free + unique**, scope and any `501` boundary stated).
- [ ] `manifest.json` valid (unique non-reserved port; `protocol`, `category`,
      `healthcheck`, `env_vars`).
- [ ] `src/server.js` exports `*Server` with `constructor(port, options)`,
      `reset()`, `start()` (rejects on bind error), `stop()`, `GET /health`, and
      `POST /__parlel/reset`. All state initialized inside `reset()`.
- [ ] **Node built-ins only** (audit B green); no new runtime deps.
- [ ] Real production driver connects **unmodified** and round-trips.
- [ ] `test/<slug>.test.ts` drives the **real client**, uses `getFreePort()` (with
      the retry pattern if booting >1 server), asserts concrete values, covers an
      error path, and cleans up (no leaks).
- [ ] **§9.1 self-audit clean, §9.2 full suite green 3×, §9.3 live smoke done.**
- [ ] `docs/<slug>.md` created/updated and **matches the implemented routes**.
- [ ] `.env.example`, `README.md` table (and `docker-compose.yml` ports if applicable) updated.
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`.
- [ ] Diff is clean: only intended files, no reformatting of untouched code, no
      dead code, no `console.log`, no secrets.
- [ ] If a repo-wide convention changed, **this `SKILL.md` was updated** too.

---

## 10. Bugs we will not ship again

Real failures from this repo's history. Each rule above traces to one of these.
Before you finish, scan this list and confirm you didn't reintroduce one.

| # | What happened | The rule that prevents it |
|---|---------------|---------------------------|
| 1 | **Port collision silently disabled a service.** The control plane defaulted to `4700`, which the `ec2` emulator owns — so ec2 failed to start whenever the control plane was on. Hidden for multiple tiers. | §1.4 prove the port is free *and* not an infra default; §9.3 live smoke would have shown ec2 missing. |
| 2 | **`getFreePort()` race → intermittent `EADDRINUSE`.** Reserving several ports up front then binding them lost the race under full-suite load. Passed in isolation, failed on run 3. | §5 allocate-and-bind-with-retry; §9.2 run the suite 3×. |
| 3 | **MCP server corrupted its own protocol.** Any `console.log` (or emulator stdout) on the MCP stdout stream breaks the JSON-RPC framing. | §4 MCP logs to stderr only; §9.1 audit C. |
| 4 | **Formatting churn buried the real change.** A bulk script reformatted 27 untouched manifests, ballooning the diff. | §0/§8 leave the diff clean; §9.1 audit E review the diff. |
| 5 | **Half-shipped feature read as complete.** `seed()` existed for 2 services but docs implied all. | §1.5 state scope explicitly; docs must match reality. |
| 6 | **Stacked PRs didn't all reach `main`.** Merging the base PR left the children behind; `main` looked done but wasn't. | §11 prefer single PRs to `main`; verify `main` actually contains the code after merge. |
| 7 | **Behavior drift during refactor.** Extracting shared code (`Fleet`) risked changing launcher behavior. | §3/§4 refactors are behavior-preserving; prove parity with the existing tests + live smoke. |

---

## 11. SHIP — PR hygiene

- **Prefer one PR straight to `main`.** Stacked PRs caused #6 above. If you must
  stack, after merging verify `main` actually contains every commit
  (`git log origin/main` / check the files exist), don't assume.
- **The PR body states what you verified** — paste the 3× suite result, the live
  smoke, and call out anything intentionally out of scope.
- **Only commit, push, or open a PR when asked.** Inspect `git status` and
  `git diff` first; stage only intended files; never commit secrets.
- **CI is not your test run.** Green CI confirms; it does not replace the §9
  protocol you run locally before pushing.
