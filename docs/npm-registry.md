# npm Registry

Lightweight, dependency-free, in-memory npm registry API fake for testing code that installs from, views, publishes to, or searches an npm-compatible registry (`npm`, `pnpm`, `yarn`).

Default port: `4776`

## Quick start

```js
import { NpmRegistryServer } from "./services/npm-registry/src/server.js";

const server = new NpmRegistryServer(4776);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point npm at it:

```bash
npm config set registry http://127.0.0.1:4776
npm view left-pad        # packument
npm view left-pad@1.3.0  # single version
```

## Access via MCP / preview URL

- Registry base URL: `http://127.0.0.1:4776`
- Set `NPM_REGISTRY_URL=http://127.0.0.1:4776` and `NPM_TOKEN=npm_parlel`.

Reads are unauthenticated; `PUT /:package` (publish) requires `Authorization: Bearer <token>` or `Basic`.

## Implemented operations

State is in-memory and ephemeral. Scoped package names (`@scope/name`) are `%2f`-encoded by clients and decoded here.

- `GET /:package` — the packument: `{ name, "dist-tags", versions, time, maintainers, ... }`.
- `GET /:package/:version` — a single version manifest (also resolves dist-tags like `latest`).
- `PUT /:package` — publish (`npm publish`); requires auth. Adds versions and applies `dist-tags`.
- `GET /-/v1/search?text=` — registry search (`{ objects, total, time }`).

Each published version carries a faithful `dist` block (`shasum`, `integrity` `sha512-...`, `tarball` URL).

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/packages` — list package names.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Packument `GET /:package` | ✅ Supported |
| Single version `GET /:package/:version` (+ dist-tag) | ✅ Supported |
| Publish `PUT /:package` (auth required) | ✅ Supported |
| Scoped packages (`@scope/name`) | ✅ Supported |
| Search `GET /-/v1/search` | ✅ Supported |
| Faithful `dist` (shasum/integrity/tarball) | ✅ Supported |
| Actual tarball (`.tgz`) bytes / download | ✓ By design — Intentional for a local, zero-cost test emulator |
| dist-tag add/rm endpoints (`/-/package/:pkg/dist-tags`) | ⟳ Roadmap |
| Deprecate / unpublish / audit | ⟳ Roadmap |
| Token scope / publish-access enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Error envelope: `{ "error": "..." }`.

| Status | When |
| --- | --- |
| `401` | publish without auth |
| `400` | invalid publish payload |
| `404` | unknown package / version |
| `405` | method not allowed |

## Manifest

See `services/npm-registry/manifest.json`:

- name: `npm-registry`, image: `parlel/npm-registry:1`
- port: `4776`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `NPM_REGISTRY_URL`, `NPM_TOKEN`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
NPM_REGISTRY_URL=http://localhost:4776
NPM_TOKEN=npm_parlel
```

<!-- parlel:testenv:end -->
