# Frontegg

Lightweight, dependency-free, in-memory fake of the **Frontegg API** over
HTTP/JSON. Exercise vendor tokens, user login, user management and tenants with
zero cost and zero side effects.

Default port: `4824`

## Quick start

```js
import { FronteggServer } from "./services/frontegg/src/server.js";

const server = new FronteggServer(4824);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `@frontegg/client` SDK at it via `FRONTEGG_BASE_URL=http://127.0.0.1:4824`.
First exchange your vendor credentials for a token:

```js
const res = await fetch("http://127.0.0.1:4824/auth/vendor", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ clientId: "parlel", secret: "parlel" }),
});
const { token } = await res.json(); // use as Bearer on /identity/resources/* routes
```

## Implemented operations

The vendor token and user login endpoints are public. The
`/identity/resources/*` management routes require `Authorization: Bearer <token>`.
State is in-memory and ephemeral; ids are deterministic UUIDs.

### Auth

- `POST /auth/vendor` — vendor token from `{ clientId, secret }` → `{ token, expiresIn, tokenType:"Bearer" }`.
- `POST /identity/resources/auth/v1/user` — user login → `{ accessToken, refreshToken, userId, email, tenantId, mfaRequired }`.

### Users (`Bearer` required)

- `GET /identity/resources/users/v1` — list users (`{ items:[], _metadata }`).
- `POST /identity/resources/users/v1` — create → `{ id, email, name, tenantId, … }`.
- `GET /identity/resources/users/v1/:userId` — retrieve.
- `PUT /identity/resources/users/v1/:userId` — update name / phone / metadata.
- `DELETE /identity/resources/users/v1/:userId` — remove.

### Tenants (`Bearer` required)

- `GET /identity/resources/tenants/v1` — list tenants (a default tenant is seeded).
- `POST /identity/resources/tenants/v1` — create → `{ id, tenantId, name, createdAt }`.

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
| Vendor token + user login | ✅ Supported |
| Users CRUD | ✅ Supported |
| Tenants list / create | ✅ Supported |
| Deterministic UUIDs + JWT-shaped tokens | ✅ Supported |
| Real JWT signing / JWKS verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Roles / permissions / feature flags / entitlements | ◐ Stored, not enforced |
| MFA / SSO / social login / passwordless flows | ⟳ Roadmap |
| Email/SMS delivery (invites, verification) | ✓ By design — Accepted, never delivered |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FRONTEGG_BASE_URL=http://localhost:4824
FRONTEGG_CLIENT_ID=parlel
FRONTEGG_API_KEY=parlel
```

<!-- parlel:testenv:end -->
