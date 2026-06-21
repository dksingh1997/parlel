# SignNow

Lightweight, dependency-free, in-memory SignNow API fake for testing e-signature code.

Default port: `4852`

## Quick start

```js
import { SignnowServer } from "./services/signnow/src/server.js";

const server = new SignnowServer(4852);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a SignNow client at `http://127.0.0.1:4852`. First exchange Basic client
credentials for a bearer token, then use the token for everything else:

```js
const basic = Buffer.from("clientId:clientSecret").toString("base64");
const tok = await fetch("http://127.0.0.1:4852/oauth2/token", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
  body: JSON.stringify({ username: "user@parlel.dev", password: "pw", grant_type: "password" }),
}).then((r) => r.json());

const me = await fetch("http://127.0.0.1:4852/user", {
  headers: { Authorization: `Bearer ${tok.access_token}` },
}).then((r) => r.json());
```

## Implemented operations

State is in-memory. Document shape: `{ id, document_name, page_count, owner, status, invites, ... }`.

- `POST /oauth2/token` — issue a bearer access token (Basic-authed). Returns `{ access_token, token_type: "bearer", expires_in, refresh_token, scope }`.
- `GET /oauth2/token` — verify a token (Bearer).
- `GET /user` — the authenticated user.
- `POST /document` — upload/create a document. Returns `{ id }`.
- `GET /document` — list documents.
- `GET /document/:id` — retrieve a document.
- `DELETE /document/:id` — delete a document.
- `POST /document/:id/invite` — send a field invite (`{ to: [{ email, role }], from }`); sets `status: "pending"`.
- `GET /document/:id/download` — returns a download URL.

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `SIGNNOW_BASE_URL` (`http://127.0.0.1:4852`). When
running in the parlel pool, an MCP tool / preview URL proxies to this base URL —
obtain a token from `/oauth2/token` then call every endpoint above with a Bearer
token, exactly as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `POST /oauth2/token` (Basic → Bearer) | ✅ Supported |
| `GET /user` | ✅ Supported |
| Documents upload/get/list/delete | ✅ Supported |
| Field invites | ✅ Supported |
| Bearer auth on protected routes | ✅ Supported |
| Multipart file upload | ◐ Accepted, body parsed loosely |
| Real PDF rendering / signing ceremony | ⟳ Roadmap |
| Templates / folders / webhooks | ⟳ Roadmap |
| Token / credential validity | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use SignNow's `{ error, error_description }` (OAuth) or `{ error, "404" }` shapes:

| Status | When |
| --- | --- |
| `401` | missing Bearer (or missing Basic on token exchange) |
| `404` | unknown document or endpoint |

## Manifest

See `services/signnow/manifest.json`:

- name: `signnow`, port: `4852`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SIGNNOW_API_KEY`, `SIGNNOW_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SIGNNOW_API_KEY=parlel
SIGNNOW_BASE_URL=http://localhost:4852
```

<!-- parlel:testenv:end -->
