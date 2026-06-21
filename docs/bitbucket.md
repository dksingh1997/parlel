# Bitbucket

Lightweight, dependency-free, in-memory Bitbucket Cloud API 2.0 fake for testing code that uses the raw Bitbucket REST API or the `bitbucket` Node SDK.

Default port: `4769`

## Quick start

```js
import { BitbucketServer } from "./services/bitbucket/src/server.js";

const server = new BitbucketServer(4769);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const res = await fetch("http://127.0.0.1:4769/2.0/user", {
  headers: { Authorization: "Bearer bbp_parlel" },
});
const user = await res.json();
// user.username => "parlel-user"
```

## Access via MCP / preview URL

- REST base URL: `http://127.0.0.1:4769/2.0`
- Set `BITBUCKET_TOKEN=bbp_parlel` and `BITBUCKET_API_URL=http://127.0.0.1:4769`.

Both `Authorization: Bearer <token>` and HTTP `Basic` (app-password) auth are accepted.

## Implemented operations

All `/2.0/*` routes require `Authorization: Bearer <token>` or `Authorization: Basic <creds>`. Collections use the Bitbucket paginated envelope `{ values, page, size, pagelen }`. State is in-memory and ephemeral.

- `GET /2.0/user` — the current authenticated user.
- `GET /2.0/repositories/:workspace` — list repositories in a workspace (paginated).
- `GET /2.0/repositories/:workspace/:repo_slug` — retrieve a repository.
- `POST/PUT /2.0/repositories/:workspace/:repo_slug` — create (`201`) or update (`200`) a repository.
- `DELETE /2.0/repositories/:workspace/:repo_slug` — delete (`204`).
- `GET /2.0/repositories/:workspace/:repo/pullrequests` — list PRs (paginated).
- `POST /2.0/repositories/:workspace/:repo/pullrequests` — create PR (`201`, requires `title`).
- `GET /2.0/repositories/:workspace/:repo/pullrequests/:id` — retrieve / `PUT` update.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.
- `GET /__parlel/repos` — list repo keys.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /2.0/user` | ✅ Supported |
| Repositories list / get / create / update / delete | ✅ Supported |
| Pull requests create / list / get / update | ✅ Supported |
| Paginated envelope `{ values, page, size, pagelen }` | ✅ Supported |
| Basic / Bearer auth | ✅ Required (any non-empty credential) |
| Real cursor pagination (`next`/`previous` links) | ⟳ Roadmap — Single page only |
| Commits / branches / pipelines / webhooks | ⟳ Roadmap |
| PR merge / approve / decline | ⟳ Roadmap — State stays `OPEN` |
| Scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Bitbucket error envelope: `{ "type": "error", "error": { "message": "..." } }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid authorization |
| `400` | missing required field (e.g. PR `title`) |
| `404` | unknown resource |
| `405` | method not allowed |

## Manifest

See `services/bitbucket/manifest.json`:

- name: `bitbucket`, image: `parlel/bitbucket:1`
- port: `4769`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `BITBUCKET_TOKEN`, `BITBUCKET_API_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
BITBUCKET_TOKEN=bbp_parlel
BITBUCKET_API_URL=http://localhost:4769
```

<!-- parlel:testenv:end -->
