# Clerk

Lightweight, dependency-free, in-memory fake of the **Clerk Backend API (v1)**
over HTTP/JSON. Exercise user, session and organization management with zero
cost and zero side effects.

Default port: `4818`

## Quick start

```js
import { ClerkServer } from "./services/clerk/src/server.js";

const server = new ClerkServer(4818);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the Clerk backend SDK at it via `CLERK_API_URL=http://127.0.0.1:4818`
and `CLERK_SECRET_KEY=sk_test_parlel`.

```js
const res = await fetch("http://127.0.0.1:4818/v1/users", {
  method: "POST",
  headers: { Authorization: "Bearer sk_test_parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ email_address: ["jane@parlel.dev"], first_name: "Jane" }),
});
const user = await res.json(); // { id: "user_…", object: "user", email_addresses: [...] }
```

## Implemented operations

All `/v1` routes require `Authorization: Bearer sk_test_…` (any non-empty bearer
is accepted). State is in-memory and ephemeral; ids are deterministic.

### Users

- `GET /v1/users` — list users.
- `POST /v1/users` — create a user → `{ id:"user_…", object:"user", email_addresses:[], first_name, … }`.
- `GET /v1/users/:id` — retrieve.
- `PATCH /v1/users/:id` — update first/last name and metadata.
- `DELETE /v1/users/:id` — delete → `{ object:"user", id, deleted:true }`.

### Sessions

- `POST /v1/sessions/:id/verify` — verify (creates+activates if unknown) → `{ object:"session", status:"active", … }`.
- `GET /v1/sessions` — list sessions.
- `GET /v1/sessions/:id` — retrieve.

### Organizations

- `GET /v1/organizations` — list (`{ data:[], total_count }`).
- `POST /v1/organizations` — create → `{ object:"organization", id:"org_…", name, slug, … }`.

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
| Users CRUD | ✅ Supported |
| Sessions verify / list / get | ✅ Supported |
| Organizations create / list | ✅ Supported |
| Deterministic `user_…` / `org_…` ids | ✅ Supported |
| Real JWT session token verification / networkless auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Email/SMS delivery, OTP, magic links | ✓ By design — Not delivered |
| Org memberships / invitations / roles | ◐ Partial (org create/list only) |
| Secret key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CLERK_SECRET_KEY=sk_test_parlel
CLERK_API_URL=http://localhost:4818
CLERK_PUBLISHABLE_KEY=pk_test_parlel
```

<!-- parlel:testenv:end -->
