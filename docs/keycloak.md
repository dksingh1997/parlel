# Keycloak

Lightweight, dependency-free, in-memory fake of the **Keycloak Admin REST API**
and the **OpenID Connect token endpoint** over HTTP/JSON. Exercise realm-scoped
user/client management and token issuance with zero cost.

Default port: `4822`

## Quick start

```js
import { KeycloakServer } from "./services/keycloak/src/server.js";

const server = new KeycloakServer(4822);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point `@keycloak/keycloak-admin-client` at it via `KEYCLOAK_URL=http://127.0.0.1:4822`
and realm `parlel`. Get a token first:

```js
const res = await fetch("http://127.0.0.1:4822/realms/parlel/protocol/openid-connect/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: "admin-cli", client_secret: "parlel" }),
});
const { access_token, token_type, expires_in } = await res.json(); // token_type: "Bearer"
```

## Implemented operations

The token endpoint accepts `application/x-www-form-urlencoded`. Admin routes
require `Authorization: Bearer <token>`. Realms `parlel` and `master` are seeded
(any realm is auto-created on first use). State is in-memory and ephemeral.

### Token

- `POST /realms/:realm/protocol/openid-connect/token` — `client_credentials`,
  `password`, `refresh_token` grants → `{ access_token, refresh_token, expires_in, token_type:"Bearer", scope }`.

### Admin — Users (`Bearer` required)

- `GET /admin/realms/:realm/users` — list users.
- `POST /admin/realms/:realm/users` — create (returns `201` + `Location` header, empty body — Keycloak style).
- `GET /admin/realms/:realm/users/:id` — retrieve → `{ id, username, email, enabled, firstName, lastName }`.
- `PUT /admin/realms/:realm/users/:id` — update (returns `204`).
- `DELETE /admin/realms/:realm/users/:id` — remove (`204`).

### Admin — Clients

- `GET /admin/realms/:realm/clients` — list clients (an `admin-cli` client is seeded).
- `POST /admin/realms/:realm/clients` — create (`201`).

### Service & control endpoints (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

preview URL (not via MCP `parlel_execute`). Use the preview URL from the Connect

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Token endpoint (client_credentials / password / refresh) | ✅ Supported |
| Admin Users CRUD (with `201` + `Location`) | ✅ Supported |
| Admin Clients list / create | ✅ Supported |
| Multi-realm (auto-created) | ✅ Supported |
| Real RS256 signing / JWKS / token introspection | ✓ By design — Tokens are not cryptographically verifiable |
| Roles / groups / role-mappings / protocol mappers | ⟳ Roadmap |
| Credential management / required actions / reset-password emails | ◐ Stored, not enforced/delivered |
| Bearer token validity / role enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
KEYCLOAK_URL=http://localhost:4822
KEYCLOAK_REALM=parlel
KEYCLOAK_CLIENT_ID=admin-cli
KEYCLOAK_CLIENT_SECRET=parlel
```

<!-- parlel:testenv:end -->
