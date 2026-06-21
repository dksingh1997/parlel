# Auth0

Lightweight, dependency-free, in-memory fake of the Auth0 **Authentication API**
and **Management API v2** over HTTP/JSON. Lets app code and AI agents exercise
Auth0 token issuance and user management with zero cost and zero side effects.

Default port: `4817`

## Quick start

```js
import { Auth0Server } from "./services/auth0/src/server.js";

const server = new Auth0Server(4817);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the Auth0 SDK / `node-auth0` at it via `AUTH0_DOMAIN=127.0.0.1:4817`
(use `http://` base for raw fetches).

```js
const res = await fetch("http://127.0.0.1:4817/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    grant_type: "client_credentials",
    client_id: "parlel",
    client_secret: "parlel",
    audience: "https://parlel/api/v2/",
  }),
});
const { access_token } = await res.json(); // realistic JWT-shaped token
```

## Implemented operations

State is in-memory and ephemeral. Token endpoints return JWT-looking
`header.payload.signature` tokens generated deterministically with `node:crypto`.

### Authentication API

- `POST /oauth/token` — `client_credentials`, `password`/`password-realm`,
  `authorization_code`, `refresh_token` grants → `{ access_token, token_type:"Bearer", expires_in, scope }`
  (password grants also return an `id_token`).
- `GET /userinfo` — `Bearer` token → `{ sub, email, email_verified, name, updated_at }`.

### Management API v2 (`Bearer` required)

- `GET /api/v2/users` — list users.
- `POST /api/v2/users` — create a user → `201 { user_id:"auth0|…", email, email_verified, created_at, … }`.
- `GET /api/v2/users/:id` — retrieve.
- `PATCH /api/v2/users/:id` — update email / verified / name / metadata / blocked.
- `DELETE /api/v2/users/:id` — remove (`204`).
- `GET /api/v2/clients` — list applications.
- `POST /api/v2/clients` — create an application.

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
| `/oauth/token` (client_credentials / password) | ✅ Supported |
| `/userinfo` | ✅ Supported |
| Management `users` CRUD | ✅ Supported |
| Management `clients` list/create | ✅ Supported |
| Deterministic JWT-shaped tokens | ✅ Supported |
| Real RS256 signing / JWKS verification | ✓ By design — Tokens are HS256-shaped, not cryptographically verifiable |
| Rules / Actions / Hooks / Flows | ⟳ Roadmap |
| Connections / MFA / passwordless flows | ⟳ Roadmap |
| Token/credential validity enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AUTH0_DOMAIN=localhost:4817
AUTH0_CLIENT_ID=parlel
AUTH0_CLIENT_SECRET=parlel
AUTH0_BASE_URL=http://localhost:4817
```

<!-- parlel:testenv:end -->
