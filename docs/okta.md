# Okta

Lightweight, dependency-free, in-memory fake of the **Okta Management API** and
**Authentication API** over HTTP/JSON. Exercise user/group management and primary
authentication with zero cost and zero side effects.

Default port: `4819`

## Quick start

```js
import { OktaServer } from "./services/okta/src/server.js";

const server = new OktaServer(4819);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `@okta/okta-sdk-nodejs` client at it via `OKTA_ORG_URL=http://127.0.0.1:4819`
and `OKTA_API_TOKEN=parlel`. Okta uses **SSWS** token auth:

```js
const res = await fetch("http://127.0.0.1:4819/api/v1/users", {
  method: "POST",
  headers: { Authorization: "SSWS parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ profile: { login: "joe@parlel.dev", email: "joe@parlel.dev", firstName: "Joe", lastName: "Q" } }),
});
const user = await res.json(); // { id: "00u…", status, profile: { login, email, ... } }
```

## Implemented operations

All `/api/v1` routes require `Authorization: SSWS <token>`. State is in-memory and
ephemeral; ids are deterministic.

### Users

- `GET /api/v1/users` — list users.
- `POST /api/v1/users` — create a user → `{ id, status, profile:{ login, email, firstName, lastName }, … }`.
- `GET /api/v1/users/:id` — retrieve.
- `POST /api/v1/users/:id` — partial profile update (Okta uses POST for partial, PUT for full).
- `DELETE /api/v1/users/:id` — first call deactivates (`DEPROVISIONED`), second deletes (`204`).
- `POST /api/v1/users/:id/lifecycle/activate` — activate (also `deactivate`, `suspend`).

### Groups

- `GET /api/v1/groups` — list (a built-in `Everyone` group is seeded).
- `POST /api/v1/groups` — create → `{ id:"00g…", type:"OKTA_GROUP", profile:{ name, description } }`.

### Authentication

- `POST /api/v1/authn` — primary auth → `{ status:"SUCCESS", sessionToken, expiresAt, _embedded:{ user } }`.

### Service & control endpoints (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

URL (not via MCP `parlel_execute`). Use the preview URL from the Connect panel

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Users CRUD + lifecycle activate/deactivate | ✅ Supported |
| Groups list / create | ✅ Supported |
| Primary auth (`/authn`) → sessionToken | ✅ Supported |
| Deterministic `00u…` / `00g…` ids | ✅ Supported |
| MFA factors / transactional auth state machine | ⟳ Roadmap — Always returns `SUCCESS` |
| OAuth2 / OIDC `/oauth2` endpoints, JWKS | ⟳ Roadmap |
| Group memberships / app assignments / policies | ◐ Partial (group create/list only) |
| SSWS token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
OKTA_ORG_URL=http://localhost:4819
OKTA_API_TOKEN=parlel
OKTA_DOMAIN=localhost:4819
```

<!-- parlel:testenv:end -->
