# Stytch

Lightweight, dependency-free, in-memory fake of the **Stytch API** over
HTTP/JSON. Exercise magic links, password auth, user management and sessions with
zero cost and zero side effects.

Default port: `4823`

## Quick start

```js
import { StytchServer } from "./services/stytch/src/server.js";

const server = new StytchServer(4823);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `stytch` Node SDK at it via a custom base URL. Stytch uses **Basic**
auth with `project_id:secret`:

```js
const auth = "Basic " + Buffer.from("project-test-parlel:secret-test-parlel").toString("base64");
const res = await fetch("http://127.0.0.1:4823/v1/passwords", {
  method: "POST",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body: JSON.stringify({ email: "pw@parlel.dev", password: "Sup3rSecret!" }),
});
const data = await res.json(); // { status_code: 200, request_id, user_id, user: {...}, session_token }
```

## Implemented operations

All `/v1` routes require `Authorization: Basic <base64(project_id:secret)>`.
Responses carry the Stytch `{ status_code, request_id, … }` envelope. State is
in-memory and ephemeral; ids are deterministic.

### Magic links

- `POST /v1/magic_links/email/login_or_create` → `{ user_id, email_id, user_created }`.

### Passwords

- `POST /v1/passwords` — create a password user → `{ user_id, user, session_token, session_jwt }`.
- `POST /v1/passwords/authenticate` — authenticate → `{ user_id, user, session_token, session_jwt }`.

### Users

- `GET /v1/users` — search/list (`{ results:[], results_metadata }`).
- `POST /v1/users` — create → `{ user_id, email_id, status, user }`.
- `GET /v1/users/:user_id` — retrieve.
- `DELETE /v1/users/:user_id` — remove → `{ user_id }`.

### Sessions

- `POST /v1/sessions/authenticate` — authenticate a `session_token` → `{ session, session_token, session_jwt, user }`.

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
| Magic links login_or_create | ✅ Supported |
| Passwords create / authenticate | ✅ Supported |
| Users create / get / list / delete | ✅ Supported |
| Sessions authenticate | ✅ Supported |
| Deterministic ids + Stytch envelope | ✅ Supported |
| Actual magic-link / OTP email & SMS delivery | ✓ By design — Captured in-memory for inspection — no real messages sent |
| OAuth / WebAuthn / TOTP / SSO flows | ⟳ Roadmap |
| B2B (organizations / member) endpoints | ⟳ Roadmap — consumer surface only |
| Real JWT/session verification + password strength (zxcvbn) | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Basic credential validity enforcement | ◐ Any valid Basic header accepted |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
STYTCH_PROJECT_ID=project-test-parlel
STYTCH_SECRET=secret-test-parlel
STYTCH_BASE_URL=http://localhost:4823
```

<!-- parlel:testenv:end -->
