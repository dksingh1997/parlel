# WorkOS

Lightweight, dependency-free, in-memory fake of the **WorkOS API** (User
Management, SSO, Organizations) over HTTP/JSON. Exercise enterprise auth flows
with zero cost and zero side effects.

Default port: `4821`

## Quick start

```js
import { WorkosServer } from "./services/workos/src/server.js";

const server = new WorkosServer(4821);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `@workos-inc/node` SDK at it via a custom base URL and
`WORKOS_API_KEY=sk_test_parlel`.

```js
const res = await fetch("http://127.0.0.1:4821/user_management/users", {
  method: "POST",
  headers: { Authorization: "Bearer sk_test_parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ email: "wos@parlel.dev", first_name: "Wo", last_name: "S" }),
});
const user = await res.json(); // { object: "user", id: "user_…", email, ... }
```

## Implemented operations

All API routes (except `GET /sso/authorize`) require `Authorization: Bearer sk_test_…`.
List responses use the WorkOS `{ object:"list", data:[], list_metadata:{ before, after } }`
envelope. State is in-memory and ephemeral; ids are deterministic.

### User Management

- `GET /user_management/users` — list users (list envelope).
- `POST /user_management/users` — create → `{ object:"user", id:"user_…", email, … }`.
- `GET /user_management/users/:id` — retrieve.
- `PUT /user_management/users/:id` — update first/last name, email_verified.
- `DELETE /user_management/users/:id` — remove.
- `POST /user_management/authenticate` — authenticate → `{ user, access_token, refresh_token, authentication_method }`.

### Organizations

- `GET /organizations` — list (list envelope).
- `POST /organizations` — create → `{ object:"organization", id:"org_…", name, domains:[], … }`.
- `GET /organizations/:id` — retrieve.

### SSO

- `GET /sso/authorize` — redirect (`302`) back to `redirect_uri` with a `?code=`.
- `POST /sso/token` — exchange a code → `{ access_token, profile:{ object:"profile", … } }`.

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
| User Management CRUD + authenticate | ✅ Supported |
| Organizations create / list / get | ✅ Supported |
| SSO authorize redirect + token exchange | ✅ Supported |
| List envelope + deterministic ids | ✅ Supported |
| Real SAML/OIDC connections, directory sync (SCIM) | ⟳ Roadmap |
| Magic Auth / MFA / email verification delivery | ✓ By design — Not delivered |
| Audit Logs / Events / Webhooks | ⟳ Roadmap |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WORKOS_API_KEY=sk_test_parlel
WORKOS_CLIENT_ID=client_parlel
WORKOS_BASE_URL=http://localhost:4821
```

<!-- parlel:testenv:end -->
