# PropelAuth

Lightweight, dependency-free, in-memory fake of the **PropelAuth Backend API**
over HTTP/JSON. Exercise backend user/org management with zero cost and zero
side effects.

Default port: `4825`

## Quick start

```js
import { PropelauthServer } from "./services/propelauth/src/server.js";

const server = new PropelauthServer(4825);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `@propelauth/node` SDK at it via `PROPELAUTH_AUTH_URL=http://127.0.0.1:4825`
and `PROPELAUTH_API_KEY=parlel`. All backend routes use `Authorization: Bearer <api-key>`:

```js
const res = await fetch("http://127.0.0.1:4825/api/backend/v1/user/", {
  method: "POST",
  headers: { Authorization: "Bearer parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ email: "pa@parlel.dev", first_name: "Pro", last_name: "Pel" }),
});
const { user_id } = await res.json();
```

## Implemented operations

All `/api/backend/v1` routes require `Authorization: Bearer <api-key>`. State is
in-memory and ephemeral; ids are deterministic UUIDs.

### Users

- `POST /api/backend/v1/user/` — create a user → `{ user_id }`.
- `GET /api/backend/v1/user/:userId` — retrieve → `{ user_id, email, email_confirmed, has_password, org_id_to_org_info, … }`.
- `GET /api/backend/v1/user/email?email=` — look up by email.
- `GET /api/backend/v1/user/username?username=` — look up by username.
- `POST /api/backend/v1/user/user_ids` — batch fetch by IDs → `{ users: [] }`.
- `POST /api/backend/v1/user/emails` — batch fetch by emails → `{ users: [] }`.
- `GET /api/backend/v1/user/query` — paginated search (`{ total_users, users:[], has_more_results, … }`).
- `GET /api/backend/v1/user/org/:orgId` — paginated users in org.
- `PUT /api/backend/v1/user/:userId` — update name / email / metadata / properties → `{}`.
- `PUT /api/backend/v1/user/:userId/email` — update email → `{}`.
- `PUT /api/backend/v1/user/:userId/password` — update password → `{}`.
- `PUT /api/backend/v1/user/:userId/clear_password` — clear password → `{}`.
- `DELETE /api/backend/v1/user/:userId` — remove → `{}`.
- `POST /api/backend/v1/user/:userId/disable` — disable/block user → `{}`.
- `POST /api/backend/v1/user/:userId/enable` — enable/unblock user → `{}`.
- `POST /api/backend/v1/user/:userId/disable_2fa` — disable MFA → `{}`.
- `POST /api/backend/v1/user/:userId/logout_all_sessions` — logout all sessions → `{}`.

### Orgs

- `GET /api/backend/v1/org/` — list orgs (`{ total_orgs, orgs:[], … }`).
- `POST /api/backend/v1/org/query` — paginated query with filters (`name`, `domain`, `order_by`) → `{ total_orgs, orgs:[], … }`.
- `POST /api/backend/v1/org/` — create → `{ org_id, name }`.
- `GET /api/backend/v1/org/:orgId` — retrieve full org object.
- `PUT /api/backend/v1/org/:orgId` — update name / domain / metadata / settings → `{}`.
- `DELETE /api/backend/v1/org/:orgId` — delete → `{}`.
- `POST /api/backend/v1/org/add_user` — add user to org with role → `{}`.
- `POST /api/backend/v1/org/remove_user` — remove user from org → `{}`.
- `POST /api/backend/v1/org/change_role` — change user role in org → `{}`.
- `POST /api/backend/v1/org/:orgId/allow_saml` — allow SAML setup → `{}`.
- `POST /api/backend/v1/org/:orgId/disallow_saml` — disallow SAML setup → `{}`.

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
| Users create / get (by id & email & username) / query / update / delete | ✅ Supported |
| User email update / password update / clear password | ✅ Supported |
| User disable / enable / disable 2FA / logout all sessions | ✅ Supported |
| Batch fetch users by IDs / emails | ✅ Supported |
| Orgs create / get / query / update / delete | ✅ Supported |
| Org membership: add user / remove user / change role | ✅ Supported |
| Org SAML allow/disallow | ✅ Supported |
| Users in org (paginated) | ✅ Supported |
| Deterministic UUIDs | ✅ Supported |
| Correct error envelopes (400 field-arrays, 401 plain text, 404 null) | ✅ Supported |
| Frontend JWT / access-token validation, JWKS | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Org memberships / roles / RBAC enforcement | ◐ Stored, not enforced |
| Magic links / invitations / email delivery | ✓ By design — Accepted, never delivered |

| End-user API keys (create / validate / delete) | ⟳ Roadmap |
| SAML / OIDC SSO connections | ⟳ Roadmap |
| Migrate user from external source | ⟳ Roadmap |
| Pending org invites | ⟳ Roadmap |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PROPELAUTH_AUTH_URL=http://localhost:4825
PROPELAUTH_API_KEY=parlel
```

<!-- parlel:testenv:end -->
