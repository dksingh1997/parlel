# LaunchDarkly

Lightweight, dependency-free, in-memory LaunchDarkly API fake for testing code that uses the real `launchdarkly-api` / `@launchdarkly/node-server-sdk` clients (and the language-agnostic LaunchDarkly REST API). Includes a minimal SDK eval endpoint.

Default port: `4816`

## Quick start

```js
import { LaunchdarklyServer } from "./services/launchdarkly/src/server.js";

const server = new LaunchdarklyServer(4816);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Drive the REST API with the `Authorization: <api-key>` header (no scheme prefix, matching LaunchDarkly):

```js
const res = await fetch("http://127.0.0.1:4816/api/v2/flags/default", {
  headers: { Authorization: "api-parlel" },
});
const { items } = await res.json();
```

State is in-memory and ephemeral.

## Implemented operations

REST routes require an `Authorization` header (any non-empty value). The SDK eval endpoint is unauthenticated, matching the streaming/polling SDK contract.

### Projects & flags

- `GET /api/v2/projects` — list projects (`{ items, _links }`).
- `GET /api/v2/flags/:projectKey` — list feature flags (`{ items, _links }`).
- `POST /api/v2/flags/:projectKey` — create a flag (`201`). Flag shape `{ key, name, kind, variations: [...], environments: {...} }`. `409` on duplicate key.
- `GET /api/v2/flags/:projectKey/:featureFlagKey` — retrieve a flag.
- `PATCH /api/v2/flags/:projectKey/:featureFlagKey` — update a flag. Supports RFC6902 `patch` (`replace /name`, `/description`) and semantic `instructions` (`turnFlagOn` / `turnFlagOff` per `environmentKey`).
- `DELETE /api/v2/flags/:projectKey/:featureFlagKey` — delete a flag (`204`).

### SDK evaluation

- `GET /sdk/eval/:envKey/users/:base64user` — evaluate all flags for a base64-encoded user. Returns `{ <flagKey>: { value, variation, version, trackEvents } }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all state (re-seeds the default project + flag).
- `GET /__parlel/flags` — list flags grouped by project.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

In a parlel pool, the service is reachable at its preview URL (host/port shown by the pool); point the API base URL / SDK base URI at it. Through the parlel MCP server, the projects/flags/eval routes are exposed as a tool surface so an AI agent can create and toggle flags and read evaluations.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Projects list | ✅ Supported |
| Flags CRUD (list/create/get/patch/delete) | ✅ Supported |
| Semantic patch (`turnFlagOn`/`turnFlagOff`) + RFC6902 subset | ✅ Supported |
| SDK `/sdk/eval` flag evaluation | ✅ Supported |
| Targeting rules / prerequisites / segments evaluation | ⟳ Roadmap — env `on` toggle drives value |
| Streaming (SSE) flag updates | ⟳ Roadmap — polling eval only |
| Experiments / Metrics / Audit log | ⟳ Roadmap |
| API-key validity / role enforcement | ✓ By design — Intentional for a local, zero-cost test emulator |

## Manifest

See `services/launchdarkly/manifest.json`:

- name: `launchdarkly`, image: `parlel/launchdarkly:1.0`
- port: `4816`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `LAUNCHDARKLY_API_KEY`, `LAUNCHDARKLY_SDK_KEY`, `LAUNCHDARKLY_HOST`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
LAUNCHDARKLY_API_KEY=api-parlel
LAUNCHDARKLY_SDK_KEY=sdk-parlel
LAUNCHDARKLY_HOST=http://localhost:4816
LAUNCHDARKLY_BASE_URL=http://localhost:4816
```

<!-- parlel:testenv:end -->
