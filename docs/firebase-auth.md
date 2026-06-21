# Firebase Auth (Identity Toolkit)

Lightweight, dependency-free, in-memory fake of the **Firebase Auth REST API**
(Google Identity Toolkit v1) over HTTP/JSON. Exercise email/password sign-up,
sign-in, lookup, update, delete and admin user creation with zero cost.

Default port: `4820`

## Quick start

```js
import { FirebaseAuthServer } from "./services/firebase-auth/src/server.js";

const server = new FirebaseAuthServer(4820);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the Firebase client SDK / REST calls at it. Set
`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:4820`. Client endpoints authenticate with
the `?key=` query parameter; admin endpoints use a `Bearer` token.

```js
const res = await fetch("http://127.0.0.1:4820/v1/accounts:signUp?key=parlel", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "new@parlel.dev", password: "Secret1!", returnSecureToken: true }),
});
const { idToken, refreshToken, localId, email } = await res.json();
```

## Implemented operations

State is in-memory and ephemeral. Tokens are JWT-shaped
`header.payload.signature` strings generated deterministically with `node:crypto`.

### Client endpoints (`?key=` required)

- `POST /v1/accounts:signUp` — create an account → `{ idToken, refreshToken, localId, email, expiresIn }`.
- `POST /v1/accounts:signInWithPassword` — sign in → `{ idToken, refreshToken, localId, email, registered:true }`.
- `POST /v1/accounts:lookup` — by `idToken` / `localId[]` / `email[]` → `{ users: [...] }`.
- `POST /v1/accounts:update` — update email / displayName / password / emailVerified / disabled.
- `POST /v1/accounts:delete` — delete an account.
- `POST /v1/accounts:sendOobCode` — accepted (no email is delivered).

### Admin endpoint (`Bearer` required)

- `POST /v1/projects/:projectId/accounts` — admin create a user → `{ localId, email }`.

### Service & control endpoints (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

preview URL (not via MCP `parlel_execute`). Use the preview URL from the Connect

host.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Email/password signUp / signIn / lookup / update / delete | ✅ Supported |
| Admin account creation (Bearer) | ✅ Supported |
| Deterministic `localId` + JWT-shaped `idToken` | ✅ Supported |
| Real RS256 signing / token verification via JWKS | ✓ By design — Tokens are not cryptographically verifiable |
| OAuth / phone / federated sign-in (Google, Apple, etc.) | ⟳ Roadmap |
| Refresh-token exchange (`securetoken.googleapis.com`) | ◐ Refresh tokens issued, exchange not implemented |
| Email/SMS delivery (OOB codes) | ✓ By design — Accepted, never delivered |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FIREBASE_AUTH_EMULATOR_HOST=localhost:4820
FIREBASE_API_KEY=parlel
FIREBASE_BASE_URL=http://localhost:4820
```

<!-- parlel:testenv:end -->
