# Parlel — Plan to become the default way devs test locally

Parlel today is a strong **foundation**: 250+ zero-dependency emulators speaking
real wire protocols, 5,400+ fidelity tests, a collision-safe launcher, per-service
docs, and a health probe. It nails *fidelity* and *contributing*.

What it is **not yet** is a tool a developer reaches for *by reflex* every time they
write a test or run code locally. The gap is not more services — it's the
**control plane, ergonomics, and integration surface** that turn "a pile of
emulators" into "the obvious local testing default."

This plan is organized by impact. Each item states the gap, the proposed change,
and why it moves Parlel toward "default."

---

## Guiding principles (do not violate)

- **Zero runtime dependencies in emulators.** This is Parlel's moat. The control
  plane / CLI / MCP layer may use Node built-ins only, same as the emulators.
- **Production drivers connect unmodified.** Any new surface is *additive* (a
  separate admin port), never a change to the emulated protocol.
- **Ephemeral by default.** New state features (seed/snapshot) are opt-in.
- **Fast.** Sub-second startup per service must stay sub-second.

---

## Tier 1 — The control plane (the single biggest unlock)

> Right now each emulator is a black box: you can connect to it, but you cannot
> *ask it anything*. There is no way to list what's running, inspect what calls
> were made, reset state between tests, or seed fixtures. This is the #1 blocker
> to Parlel being a real testing default — test isolation is impossible without
> a reset, and debugging is impossible without inspection.

### 1.1 Admin / control API (one extra port for the whole fleet)

Add a single **control-plane HTTP server** (e.g. `localhost:4700`) that the
launcher starts alongside the emulators. Pure Node `node:http`. Endpoints:

- `GET  /services` — list running services: slug, port, protocol, uptime, health.
- `GET  /services/:slug/state` — dump current in-memory state (objects, rows, keys).
- `POST /services/:slug/reset` — clear that service's state. **(test isolation)**
- `POST /reset` — reset *all* services at once. **(per-test `beforeEach`)**
- `GET  /services/:slug/requests` — request log: every call the emulator received
  (method, path, headers, body, response, timestamp). **(debugging)**
- `POST /services/:slug/seed` — load fixture data (see 1.3).
- `GET  /healthz` — aggregate health of the whole fleet.

To support this with zero changes to emulator protocols, define a tiny optional
**emulator contract** the control plane introspects:

```js
export class StripeServer {
  // already have: constructor, start, stop
  reset() { /* clear in-memory state */ }      // optional, control plane calls it
  dump()  { return this.state; }               // optional, for /state
  // request log is captured by a thin wrapper the launcher installs (see 1.2)
}
```

Emulators that don't implement `reset`/`dump` degrade gracefully (control plane
reports "not supported"). Many services likely already have a `reset()` — audit
and standardize the signature.

**Why it matters:** This is what makes Parlel usable *inside a test suite*.
`beforeEach(() => fetch('localhost:4700/reset', {method:'POST'}))` gives every
test a clean slate without restarting containers (which is too slow per-test).

### 1.2 Universal request recorder

The launcher wraps each emulator's HTTP handler (and a hook for TCP services) to
record requests into a ring buffer (capped, e.g. last 1,000). Exposed via the
control API. This is the feature that answers the question developers actually
have: **"did my code call the API the way I think it did?"** — the thing mocks
give you and real services don't.

- Opt-out via env (`PARLEL_RECORD=0`) for max performance.
- `GET /services/:slug/requests?since=<ts>` for assertions in tests:
  *"assert Stripe received exactly one POST /v1/charges with amount=2000."*

### 1.3 Seeding & fixtures

Ephemeral is the right default, but "always empty" is sometimes wrong (you need a
user to exist before testing login). Add:

- `POST /services/:slug/seed` with a JSON body the emulator loads.
- A declarative `parlel.fixtures.json` at repo root the launcher loads on boot:
  ```json
  {
    "postgres": { "sql": "CREATE TABLE users(...); INSERT ..." },
    "stripe":   { "customers": [{ "id": "cus_test", "email": "a@b.com" }] }
  }
  ```
- Per-emulator `seed(data)` method (optional, same contract pattern as `reset`).

### 1.4 Snapshots (stretch)

`POST /snapshot` → returns an opaque blob of all in-memory state; `POST /restore`
loads it. Enables "set up an expensive scenario once, restore it before each
test" — much faster than re-seeding. Build on `dump()`/`seed()`.

---

## Tier 2 — A real CLI

> Today the interface is `SERVICES=postgres,redis node src/launch.mjs` and editing
> env vars. That's friction. A first-class CLI is table stakes for a "default" tool.

Add a `parlel` CLI (the `bin` already exists — expand it). Subcommands:

- `parlel up postgres redis stripe` — start services (foreground or `-d` detached).
- `parlel down` — stop the detached fleet.
- `parlel status` — table of running services, ports, health, uptime (hits 1.1).
- `parlel logs [slug]` — tail emulator logs / request log.
- `parlel reset [slug]` — wipe state (hits 1.1).
- `parlel ls` — list all 250 available services + their ports (searchable:
  `parlel ls payments`).
- `parlel inspect stripe` — show the request log / state for one service.
- `parlel doctor` — preflight: Node version, port conflicts, Docker availability.
- `parlel seed <file>` — load fixtures.

Ship as `npx parlel` so the first-run experience is **zero install**:
```bash
npx parlel up postgres stripe
```

**Why it matters:** "default tool" means muscle-memory commands. `npx parlel up`
should be as reflexive as `docker compose up`.

---

## Tier 3 — Test-framework integration (make it *the* default in tests)

> The whole pitch is "test locally." Yet there's no first-class way to wire Parlel
> into a test runner. Developers have to hand-roll `beforeAll`/`afterAll`. Provide
> adapters so adopting Parlel in a test suite is two lines.

### 3.1 A tiny client library (`@parlel/client`, pure Node, optional)

A thin wrapper over the control API:
```js
import { parlel } from "@parlel/client";
const p = await parlel.up(["postgres", "stripe"]);
await p.reset();                       // between tests
p.stripe.requests();                   // assert calls
await p.down();
```

### 3.2 Vitest / Jest global setup

```js
// vitest.config.ts
import { parlelSetup } from "@parlel/client/vitest";
export default { test: { globalSetup: parlelSetup(["postgres", "stripe"]) } };
```
Auto-starts the fleet, injects connection env vars, resets between files.

### 3.3 pytest plugin

Given the README leads with `psycopg`/Python, a `pytest-parlel` fixture is high
leverage:
```python
def test_charge(parlel):
    parlel.up("stripe")
    ...
    assert parlel.stripe.requests("POST", "/v1/charges")
```

### 3.4 Connection-string helper

A single source of truth that hands back correct connection strings/URLs for
whatever ports were actually bound (important since `up.mjs` remaps busy ports —
right now the remapped port is only *printed*, not *queryable*). Wire this into
the control API (`GET /services/:slug` returns `connection_string`).

---

## Tier 4 — The MCP server (deliver the AI-agent thesis)

> The README's headline is "a verification layer for AI coding agents" and the
> roadmap lists an MCP server — but it doesn't exist. Without it, the core
> differentiating story is unfulfilled. This is what makes Parlel *the* agent
> testing tool rather than just another LocalStack.

Build an MCP server (built-ins only) exposing tools an agent calls directly:

- `parlel_start_services(slugs)` → boots them, returns connection info.
- `parlel_list_services(category?)` → discover what's available.
- `parlel_get_requests(slug)` → agent inspects what its code did (closes the
  verify loop: agent writes code → runs it → reads the request log → asserts).
- `parlel_reset(slug?)` → clean slate between agent iterations.
- `parlel_seed(slug, data)` → set up scenarios.
- `parlel_stop_services()`.

Pair with an **`AGENTS.md`** (currently missing despite the agent positioning)
that teaches an agent the workflow: *"need to test code that calls Stripe? Start
the emulator, point at localhost, run, then read the request log to verify."*

---

## Tier 5 — Observability & DX polish

- **Web dashboard (optional, stretch):** `localhost:4700/` serves a tiny static
  UI over the control API — see running services, live request stream, reset
  buttons, state inspector. Zero deps (vanilla HTML/JS). This is a "wow" demo
  that drives adoption.
- **Structured logging:** consistent JSON log lines from the launcher with
  request IDs, so output is greppable/pipeable.
- **Better remap UX:** the busy-port remap is currently fire-and-forget text.
  Surface it in `parlel status` and the control API so tooling can read it.

---

## Tier 6 — Code hygiene & reliability (foundation for contributors)

The repo has 130K+ lines of hand-written JS with **no linter, no formatter, no
coverage, no typecheck**. For a project whose growth model is "community adds
services," inconsistency will compound.

- **Add Biome** (single binary, fast, zero-config-ish, fits the zero-dep ethos):
  `npm run lint`, `npm run format`. Wire into CI.
- **Coverage:** `vitest run --coverage` with a reporter; track per-service
  coverage so gaps (e.g. `apigateway` stub) are visible.
- **Lightweight typecheck:** a `jsconfig.json` + `tsc --noEmit --checkJs` on the
  emulators, or at least typecheck the `.test.ts` files. Catches drift early.
- **CI matrix:** test on Node 20 / 22 / 24 (engines say >=20 but CI only runs 24)
  and ideally macOS + Linux.
- **Replace `sleep 8` in CI** with a readiness poll against the new control-plane
  `/healthz` — removes flakiness and speeds CI.
- **Conformance test:** a single meta-test that asserts every service implements
  the emulator contract (`start`/`stop`, and `reset`/`dump` where claimed),
  manifest is valid, port is unique, and a test file exists. Prevents the
  `apigateway`-style drift.
- **`AGENTS.md` / `CONTRIBUTING` update:** document the control-plane contract so
  new emulators implement `reset()`/`dump()` from day one.

---

## Tier 7 — Record / replay (roadmap item, longer horizon)

Record real upstream responses once, replay them offline. Turns Parlel into a
fidelity-checker for services too complex to fully emulate. Build on the request
recorder (1.2): record mode proxies to the real service and captures; replay mode
serves from the capture. Strictly opt-in, network-gated.

---

## Suggested sequencing

| Phase | Items | Outcome |
|-------|-------|---------|
| **1** | 1.1 control API, 1.2 recorder, Tier 6 lint/coverage | Test isolation + debugging + clean foundation. The unlock. |
| **2** | Tier 2 CLI, 3.4 connection helper, CI readiness poll | Reflexive UX; `parlel up` / `parlel status`. |
| **3** | 1.3 seeding, 3.1–3.3 test adapters | Two-line adoption in real test suites. |
| **4** | Tier 4 MCP + AGENTS.md | Deliver the agent thesis. |
| **5** | 1.4 snapshots, Tier 5 dashboard, Tier 7 record/replay | Differentiated polish. |

---

## What success looks like

A developer (or agent) writes code that touches Stripe + Postgres, runs:

```bash
npx parlel up stripe postgres
```

points their unmodified driver at `localhost`, runs their tests with a
`@parlel/client` fixture that resets state between cases, and asserts against the
recorded request log — all locally, free, in under a second of startup, with zero
risk to production. That reflexive `npx parlel up` is the goal.

---

## Delivery — 10 PRs

Each PR is independently shippable, has its own tests/docs/changelog entry, and
builds on the ones before it. **PRs 1–4 are Tier 1 (ship today).**

### Tier 1 — Control plane (PRs 1–4, today)

**PR 1 — Emulator control contract + audit/standardize `reset()`** *(foundation)*
- Define the optional emulator contract the control plane introspects: `reset()`,
  `dump()`, `seed(data)`, plus the namespaced `__parlel` admin routes already used
  by some services.
- Audit all 250 services: standardize the `reset()` signature, add `POST
  /__parlel/reset` where missing on HTTP services, make graceful-degrade explicit
  (control plane reports "not supported" when a method is absent).
- A conformance meta-test asserting the contract across services.
- Docs: update `CONTRIBUTING.md` + `SKILL.md` with the contract. Changelog entry.

**PR 2 — Control-plane HTTP server + `/services` + `/healthz` + reset** *(1.1 core)*
- New `src/control-plane.mjs` (pure Node `node:http`), started by the launcher on
  `localhost:4700` (configurable via `PARLEL_CONTROL_PORT`, opt-out env).
- Endpoints: `GET /services`, `GET /healthz`, `POST /reset`,
  `POST /services/:slug/reset`, `GET /services/:slug/state` (via `dump()`).
- Launcher registers each started server instance with the control plane.
- Tests against the control API; docs page `docs/control-plane.md`; changelog.

**PR 3 — Universal request recorder + `/requests`** *(1.2)*
- Launcher installs a thin wrapper around each HTTP emulator's handler to record
  `{method, path, headers, body, status, ts}` into a per-service capped ring
  buffer (default 1,000). TCP hook stubbed for a later PR.
- `GET /services/:slug/requests?since=<ts>` on the control plane.
- Opt-out via `PARLEL_RECORD=0`. Performance check that recording stays sub-ms.
- Tests asserting "service received exactly one POST /v1/charges". Docs + changelog.

**PR 4 — Seeding & fixtures** *(1.3)*
- `seed(data)` contract method; `POST /services/:slug/seed` on the control plane.
- Declarative `parlel.fixtures.json` loaded on boot by the launcher.
- Implement `seed()` for the high-value services (postgres, stripe, redis, s3) and
  document the per-service seed shape; others report "not supported".
- Tests for fixture-on-boot and runtime seed; docs + changelog.
- **End of Tier 1.**

### Tier 6 — Hygiene foundation (PRs 5–6, fast follow)

**PR 5 — Biome lint + format + CI wiring**
- Add Biome (single binary), `npm run lint` / `npm run format`, baseline config
  matching existing style, wire into CI. Auto-format pass as its own commit.

**PR 6 — Coverage + CI readiness poll + matrix**
- `vitest run --coverage` with reporter; per-service coverage surfaced.
- Replace CI `sleep 8` with a readiness poll against `/healthz` (depends on PR 2).
- CI matrix: Node 20/22/24.

### Tier 2 — CLI (PRs 7–8)

**PR 7 — `parlel` CLI core: `up` / `down` / `status` / `ls`**
- Expand the existing `bin`. `up [-d]`, `down`, `status` (hits control plane),
  `ls [filter]`. `npx parlel up postgres stripe` zero-install path.

**PR 8 — CLI inspect/reset/seed/doctor + connection helper** *(3.4)*
- `inspect <slug>`, `reset [slug]`, `seed <file>`, `doctor` preflight.
- Connection-string helper: control plane `GET /services/:slug` returns the actual
  bound `connection_string` (resolves the `up.mjs` remap-only-printed gap).

### Tier 3/4 — Adoption + agents (PRs 9–10)

**PR 9 — `@parlel/client` + vitest/jest global setup** *(3.1–3.2)*
- Thin pure-Node client over the control API; vitest `globalSetup` helper that
  boots the fleet, injects connection env, resets between files.

**PR 10 — MCP server + `AGENTS.md`** *(Tier 4)*
- MCP server (built-ins only) exposing `start_services`, `list_services`,
  `get_requests`, `reset`, `seed`, `stop_services`.
- `AGENTS.md` teaching the agent verify-loop workflow.

**Later (not in the 10):** 1.4 snapshots, Tier 5 dashboard, Tier 7 record/replay,
pytest plugin (3.3) — tracked as follow-ups.

### Today's target

Ship **PRs 1–4** = all of Tier 1. Outcome: every emulator resettable and
inspectable through one control port, request recording for assertions, and
fixture seeding — Parlel becomes usable *inside a test suite*.
