# Front

Lightweight, dependency-free, in-memory fake of the Front API for testing code that talks to the Front REST API directly.

Default port: `4785`

## Quick start

```js
import { FrontServer } from "./services/front/src/server.js";

const server = new FrontServer(4785);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const base = "http://127.0.0.1:4785";
const res = await fetch(`${base}/conversations`, {
  method: "POST",
  headers: { Authorization: "Bearer pat-parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ subject: "Hi there" }),
});
// => { _links: { self }, id: "cnv_...", subject, status, ... }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4785`, reachable through the parlel MCP/preview proxy under the slug `front`.

## Implemented operations

All API routes require `Authorization: Bearer <token>` (any non-empty bearer works). State is in-memory and ephemeral.

Resource shape: `{ _links: { self, related }, id, ... }` (ids are prefixed — `cnv_` conversation, `crd_` contact, `msg_` message, `cha_` channel).
List shape: `{ _pagination: { next }, _links: { self }, _results: [...] }`.

### Conversations — `/conversations`

- `POST /conversations` — create.
- `GET /conversations` — list.
- `GET /conversations/:id` — retrieve.
- `PATCH /conversations/:id` — update (`204`).
- `POST /conversations/:id/messages` — reply to a conversation (`202`).

### Contacts — `/contacts`

- `POST /contacts` — create.
- `GET /contacts` — list.
- `GET /contacts/:id` — retrieve.
- `PATCH /contacts/:id` — update (`204`).
- `DELETE /contacts/:id` — delete (`204`).

### Channels — `/channels/:channel_id/messages`

- `POST /channels/:channel_id/messages` — send an outbound message (`202`). A default channel `cha_parlel` is seeded.

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
| Conversations create/list/get/update | ✅ Supported |
| Contacts CRUD | ✅ Supported |
| Channel + conversation reply messages | ✅ Supported |
| HAL-ish `_links` / `_results` / `_pagination` shapes | ✅ Supported |
| Comments / drafts / tags / inboxes / teammates | ⟳ Roadmap |
| Async message-import / send polling endpoints | ◐ Returns `202` synchronously |
| Pagination beyond first page | ◐ `_pagination.next` always null |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the Front envelope `{ _error: { status, title, message } }`.

| Status | `title` | When |
| --- | --- | --- |
| `400` | `bad_request` | malformed JSON body |
| `401` | `unauthorized` | no `Authorization: Bearer` header |
| `404` | `not_found` | unknown id / endpoint |
| `405` | `method_not_allowed` | method not allowed for the path |

## Manifest

See `services/front/manifest.json`: name `front`, port `4785`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `FRONT_API_TOKEN`, `FRONT_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FRONT_API_TOKEN=pat-parlel
FRONT_BASE_URL=http://localhost:4785
```

<!-- parlel:testenv:end -->
