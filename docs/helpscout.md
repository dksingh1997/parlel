# Help Scout

Lightweight, dependency-free, in-memory fake of the Help Scout Mailbox API v2 for testing code that talks to the Help Scout REST API directly.

Default port: `4786`

## Quick start

```js
import { HelpscoutServer } from "./services/helpscout/src/server.js";

const server = new HelpscoutServer(4786);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it (grab a token, then call resources):

```js
const base = "http://127.0.0.1:4786";

const tok = await fetch(`${base}/v2/oauth2/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ grant_type: "client_credentials", client_id: "parlel", client_secret: "pat-parlel" }),
}).then((r) => r.json());

const created = await fetch(`${base}/v2/conversations`, {
  method: "POST",
  headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ subject: "Help me", mailboxId: 1, type: "email", customer: { email: "u@parlel.dev" } }),
});
// 201, with a `Resource-ID` response header pointing at the new conversation.
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4786`, reachable through the parlel MCP/preview proxy under the slug `helpscout`.

## Implemented operations

`POST /v2/oauth2/token` is unauthenticated; all other `/v2/*` routes require `Authorization: Bearer <token>` (any non-empty bearer works). State is in-memory and ephemeral.

Collections use the HAL shape: `{ _embedded: { conversations: [...] }, _links: {...}, page: {...} }`. Creates return `201` with a `Resource-ID` header (and `Location`) and no body, matching the real API.

### OAuth — `/v2/oauth2/token`

- `POST /v2/oauth2/token` — exchange a grant (`grant_type` required) for `{ token_type: "bearer", access_token, expires_in }`.

### Conversations — `/v2/conversations`

- `POST /v2/conversations` — create (`subject` + `mailboxId` required) → `201` + `Resource-ID`.
- `GET /v2/conversations` — list (`?page=&size=`).
- `GET /v2/conversations/:id` — retrieve.
- `PUT`/`PATCH /v2/conversations/:id` — update (`204`).
- `DELETE /v2/conversations/:id` — delete (`204`).

### Customers — `/v2/customers`

CRUD surface (one of `firstName`/`lastName`/`emails` required on create).

### Mailboxes — `/v2/mailboxes`

List/retrieve. A default mailbox (`id: 1`) is seeded.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| OAuth2 client-credentials token grant | ✅ Supported |
| Conversations CRUD | ✅ Supported |
| Customers CRUD | ✅ Supported |
| Mailboxes list/retrieve (seeded) | ✅ Supported |
| HAL `_embedded` / `_links` / `page` envelopes | ✅ Supported |
| `Resource-ID` create header (201, no body) | ✅ Supported |
| Threads / attachments / tags / workflows | ⟳ Roadmap |
| Token expiry / refresh-token flow | ◐ Tokens never expire (until reset) |
| Embedded sub-resource expansion (`?embed=`) | ⟳ Roadmap |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ error, message }`; validation errors add `_embedded.errors[]`.

| Status | When |
| --- | --- |
| `400` | malformed JSON / missing `grant_type` / validation failure |
| `401` | no `Authorization: Bearer` header |
| `404` | unknown id / resource |
| `405` | method not allowed for the path |

## Manifest

See `services/helpscout/manifest.json`: name `helpscout`, port `4786`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `HELPSCOUT_APP_ID`, `HELPSCOUT_APP_SECRET`, `HELPSCOUT_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
HELPSCOUT_APP_ID=parlel
HELPSCOUT_APP_SECRET=pat-parlel
HELPSCOUT_BASE_URL=http://localhost:4786
```

<!-- parlel:testenv:end -->
