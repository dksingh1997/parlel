# Vercel

Lightweight, dependency-free, in-memory Vercel REST API fake for testing code that uses the Vercel REST API or `@vercel/client`.

Default port: `4770`

## Quick start

```js
import { VercelServer } from "./services/vercel/src/server.js";

const server = new VercelServer(4770);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const res = await fetch("http://127.0.0.1:4770/v2/user", {
  headers: { Authorization: "Bearer vercel_parlel" },
});
const { user } = await res.json();
// user.username => "parlel-user"
```

## Access via MCP / preview URL

- REST base URL: `http://127.0.0.1:4770`
- Set `VERCEL_TOKEN=vercel_parlel` and `VERCEL_API_URL=http://127.0.0.1:4770`.

All API routes require `Authorization: Bearer <token>` (any non-empty token accepted).

## Implemented operations

State is in-memory and ephemeral. Versioned paths mirror the real Vercel API.

- `GET /v2/user` — current user, wrapped as `{ user }`.
- `GET /v9/projects` — list projects (`{ projects, pagination }`).
- `POST /v9/projects` — create project (requires `name`).
- `GET /v9/projects/:idOrName` — retrieve a project by id or name.
- `PATCH /v9/projects/:idOrName` — update name/framework.
- `DELETE /v9/projects/:idOrName` — delete (`204`).
- `POST /v13/deployments` — create a deployment (requires `name`); returns `READY` deployment with `.vercel.app` URL.
- `GET /v6/deployments` — list deployments (`{ deployments, pagination }`).
- `GET /v6/deployments/:id` — retrieve a deployment by id or url.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /v2/user` | ✅ Supported |
| Projects list / create / get / patch / delete | ✅ Supported |
| Deployments create / list / get | ✅ Supported |
| Bearer auth | ✅ Required (any non-empty token) |
| Real build pipeline / file uploads | ⟳ Roadmap — Deployment is instantly `READY` |
| Domains / env vars / aliases / teams | ⟳ Roadmap |
| Cursor pagination | ⟳ Roadmap — Single page |
| Scope / team enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Vercel error envelope: `{ "error": { "code": "...", "message": "..." } }`.

| Status | When |
| --- | --- |
| `403` | missing/invalid authorization |
| `400` | missing required field (`name`) |
| `404` | unknown resource |
| `405` | method not allowed |

## Manifest

See `services/vercel/manifest.json`:

- name: `vercel`, image: `parlel/vercel:1`
- port: `4770`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `VERCEL_TOKEN`, `VERCEL_API_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
VERCEL_TOKEN=vercel_parlel
VERCEL_API_URL=http://localhost:4770
```

<!-- parlel:testenv:end -->
