# Changelog

All notable changes to Parlel are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Universal request recorder** (`src/request-recorder.mjs`). The launcher
  installs it on each HTTP emulator's server (zero emulator code changes),
  capturing every request — method, path, query, headers (secrets redacted),
  request/response bodies, status, and timing — into a per-service capped ring
  buffer (default 1,000). Exposed via the control plane at
  `GET /services/:slug/requests` with `method`/`path`/`since`/`limit` filters, so
  tests can assert "the service received exactly one POST /v1/charges". Cleared
  on reset. Disable with `PARLEL_RECORD=0`; tune via `PARLEL_RECORD_CAP` /
  `PARLEL_RECORD_MAX_BODY`.
- **Control plane** (`src/control-plane.mjs`) — a single additive admin HTTP
  server (default `localhost:4700`) started alongside the emulators by the
  launcher. Endpoints: `GET /`, `GET /healthz`, `GET /services`,
  `GET /services/:slug`, `GET /services/:slug/state` (via `dump()`),
  `POST /services/:slug/reset`, and `POST /reset` (reset the whole fleet — the
  per-test isolation primitive). Returns ready-to-use `connection_string`s.
  Configurable via `PARLEL_CONTROL_PORT`; disable with `PARLEL_CONTROL=0`. Pure
  Node, zero dependencies. Documented in `docs/control-plane.md`.
- **Emulator contract conformance test** (`test/conformance.test.ts`). Asserts
  across the whole catalog that every service has a valid manifest, a unique port,
  a `src/server.js` exporting a `*Server` class, and that the class implements
  `start()`, `stop()`, and `reset()`. Guards against convention drift as the
  catalog grows. Includes a live boot → `/health` → `reset()` smoke test for a
  representative sample of services.
- **`reset()` standardized as part of the emulator contract.** Added `reset()` to
  the services that were missing it (`cassandra`, `kafka`, `mysql`, `rabbitmq`,
  `elasticsearch`, `supabase`), so every emulator can be returned to a clean state
  for per-test isolation and by the forthcoming Parlel control plane.

### Changed

- `CONTRIBUTING.md` now documents the full emulator contract (`reset()` required,
  all state initialized inside `reset()`), and the PR checklist references the
  conformance test.
