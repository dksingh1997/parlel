# Heroku

Lightweight, dependency-free, in-memory fake of the **Heroku Platform API v3** for testing deploy/ops automation. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4883`

## Quick start

```js
import { HerokuServer } from "./services/heroku/src/server.js";

const server = new HerokuServer(4883);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with `Authorization: Bearer <key>` and send the v3 Accept header (any non-empty key accepted):

```bash
curl -H "Authorization: Bearer parlel" \
     -H "Accept: application/vnd.heroku+json; version=3" \
     http://127.0.0.1:4883/apps
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `HEROKU_API_KEY=parlel` and `HEROKU_BASE_URL=http://127.0.0.1:4883`, then drive the Platform API v3. The MCP server proxies the endpoints below so an agent can manage apps, config vars, and dynos without a real Heroku account.

## Implemented operations

All endpoints (except `/`, `/health`) require `Authorization: Bearer <key>` (any non-empty key accepted). Clients should send `Accept: application/vnd.heroku+json; version=3`.

- `GET /account` — the authenticated account.
- `GET /apps` — list apps.
- `POST /apps` — create an app → `201`. App shape: `{ id, name, web_url, git_url, region, stack, created_at, ... }`. Duplicate/invalid names → `422`.
- `GET /apps/:id_or_name` — retrieve an app (by UUID or name).
- `PATCH /apps/:id_or_name` — update (rename, maintenance).
- `DELETE /apps/:id_or_name` — delete an app.
- `GET /apps/:app/config-vars` — get config vars.
- `PATCH /apps/:app/config-vars` — set/unset config vars (`null` value removes a key).
- `GET /apps/:app/dynos` — list dynos.
- `POST /apps/:app/dynos` — create a one-off dyno → `201 { state: "up", ... }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Apps create/list/get/update/delete (by id or name) | ✅ Supported |
| Config vars get/set/unset | ✅ Supported |
| Dynos list/create | ✅ Supported |
| Account get | ✅ Supported |
| Real build/release/slug pipeline | ⟳ Roadmap — Intentionally unsupported |
| Releases / formation / add-ons / pipelines / domains | ⟳ Roadmap |
| Range-based pagination (`Range` header) | ⟳ Roadmap — Full list returned |
| Dyno lifecycle (restart/stop, actual process) | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Manifest

See `services/heroku/manifest.json`:

- name: `heroku`, port: `4883`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `HEROKU_API_KEY`, `HEROKU_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
HEROKU_API_KEY=parlel
HEROKU_BASE_URL=http://localhost:4883
```

<!-- parlel:testenv:end -->
