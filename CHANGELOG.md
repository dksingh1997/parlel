# Changelog

All notable changes to Parlel are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
