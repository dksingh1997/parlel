# Docker Registry

Lightweight, dependency-free, in-memory Docker Registry HTTP API V2 fake — the protocol `docker push`, `docker pull`, and `skopeo` speak. Implements enough of the distribution spec to list, push and pull manifest metadata for testing.

Default port: `4775`

## Quick start

```js
import { DockerRegistryServer } from "./services/docker-registry/src/server.js";

const server = new DockerRegistryServer(4775);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Probe the API and pull a manifest:

```js
await fetch("http://127.0.0.1:4775/v2/"); // 200 {}
await fetch("http://127.0.0.1:4775/v2/library/hello-world/manifests/latest");
// Docker-Content-Digest: sha256:...
```

## Access via MCP / preview URL

- Registry base URL: `http://127.0.0.1:4775/v2`
- Set `DOCKER_REGISTRY_URL=http://127.0.0.1:4775` and `REGISTRY_HTTP_ADDR=127.0.0.1:4775`.

No authentication is required (a `Bearer` token is accepted but never enforced), matching a local insecure registry.

## Implemented operations

State is in-memory and ephemeral. All routes live under `/v2`.

- `GET /v2/` — API version check; returns `200 {}` with `Docker-Distribution-Api-Version: registry/2.0`.
- `GET /v2/_catalog` — list repositories (`{ repositories }`).
- `GET /v2/:name/tags/list` — list tags for a repository (`{ name, tags }`).
- `HEAD/GET /v2/:name/manifests/:reference` — fetch a manifest by tag or digest; sets `Docker-Content-Digest`.
- `PUT /v2/:name/manifests/:reference` — push a manifest (`201`); registers the tag and digest.
- `POST /v2/:name/blobs/uploads/` — start a blob upload session (`202 + Location + Docker-Upload-Uuid`). With `?digest=` and a body, performs a monolithic upload (`201`).
- `PATCH /v2/:name/blobs/uploads/:uuid` — append a chunk (`202`).
- `PUT /v2/:name/blobs/uploads/:uuid?digest=...` — complete the upload (`201 + Docker-Content-Digest`).
- `HEAD/GET /v2/:name/blobs/:digest` — pull a blob.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/repositories` — list repository names.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /v2/` version check | ✅ Supported (`200 {}`) |
| Catalog | ✅ Supported |
| Tag list | ✅ Supported |
| Manifest HEAD / GET / PUT (+ `Docker-Content-Digest`) | ✅ Supported |
| Blob upload session (POST/PATCH/PUT) + pull | ✅ Supported |
| Token/`Bearer` auth challenge flow (`WWW-Authenticate`) | ✓ By design — Not enforced (insecure registry) |
| Manifest list / OCI index fat manifests | ◐ Stored as opaque bytes |
| Cross-repo blob mount / delete / GC | ⟳ Roadmap |
| Real layer streaming / content addressing validation | ◐ Digest taken from `?digest=` or computed |

## Error codes & shapes

Registry error envelope: `{ "errors": [{ "code": "MANIFEST_UNKNOWN", "message": "..." }] }`.

| Status | When |
| --- | --- |
| `404` | unknown repo / manifest / blob |
| `405` | unsupported method on a route |

## Manifest

See `services/docker-registry/manifest.json`:

- name: `docker-registry`, image: `parlel/docker-registry:1`
- port: `4775`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `DOCKER_REGISTRY_URL`, `REGISTRY_HTTP_ADDR`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DOCKER_REGISTRY_URL=http://localhost:4775
REGISTRY_HTTP_ADDR=127.0.0.1:4775
```

<!-- parlel:testenv:end -->
