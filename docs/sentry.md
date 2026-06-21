# Sentry

Lightweight, dependency-free, in-memory Sentry API fake for testing code that uses the Sentry management API (`sentry-cli`, dashboards) and the event-ingest endpoint used by the Sentry SDKs.

Default port: `4773`

## Quick start

```js
import { SentryServer } from "./services/sentry/src/server.js";

const server = new SentryServer(4773);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Send an event (SDK-style ingest) or call the management API:

```js
// Ingest an event
await fetch("http://127.0.0.1:4773/api/1/store/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Boom", level: "error" }),
});

// List projects (management API, requires Bearer)
const res = await fetch("http://127.0.0.1:4773/api/0/organizations/parlel/projects/", {
  headers: { Authorization: "Bearer sntrys_parlel" },
});
```

## Access via MCP / preview URL

- Management API base URL: `http://127.0.0.1:4773/api/0`
- Ingest endpoint: `http://127.0.0.1:4773/api/:project_id/store/`
- Set `SENTRY_AUTH_TOKEN=sntrys_parlel`, `SENTRY_API_URL=http://127.0.0.1:4773`, and `SENTRY_DSN=http://parlel@127.0.0.1:4773/1`.

The management API requires `Authorization: Bearer <token>`. The ingest endpoint is lenient (matches DSN-based auth in local testing).

## Implemented operations

State is in-memory and ephemeral; every ingested event is captured.

- `POST /api/:project_id/store/` — event ingest. Returns `200 { id }` and records the event; surfaces it as an issue under the seeded project.
- `GET /api/0/organizations/:org/projects/` — list projects in an org.
- `GET /api/0/projects/:org/:project/` — retrieve a project.
- `POST /api/0/projects/:org/:project/` — create a project (`201`).
- `GET /api/0/projects/:org/:project/issues/` — list issues.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/events` — list every captured ingest event (`{ events, count }`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Event ingest (`/store/`) | ✅ Supported (captured, never forwarded) |
| Org project listing | ✅ Supported |
| Project get / create | ✅ Supported |
| Issues listing | ✅ Supported |
| Bearer auth on management API | ✅ Required |
| Envelope ingest (`/envelope/`) / minidumps | ⟳ Roadmap |
| Releases / alerts / teams / members | ⟳ Roadmap |
| Real grouping / fingerprinting | ◐ Each event becomes one issue |
| DSN signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |

## Error codes & shapes

Sentry error envelope: `{ "detail": "..." }`.

| Status | When |
| --- | --- |
| `401` | management API called without Bearer |
| `404` | unknown org/project/resource |
| `405` | method not allowed |

## Manifest

See `services/sentry/manifest.json`:

- name: `sentry`, image: `parlel/sentry:1`
- port: `4773`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SENTRY_AUTH_TOKEN`, `SENTRY_API_URL`, `SENTRY_DSN`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SENTRY_AUTH_TOKEN=sntrys_parlel
SENTRY_API_URL=http://localhost:4773
SENTRY_DSN=http://parlel@127.0.0.1:4773/1
```

<!-- parlel:testenv:end -->
