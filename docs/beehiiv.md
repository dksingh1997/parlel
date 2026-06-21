# beehiiv

Lightweight, dependency-free, in-memory beehiiv API v2 fake for testing code that uses the language-agnostic beehiiv v2 REST API. Matches the real wire protocol: Bearer auth, JSON request/response bodies, `{ data: {...} }` single-object envelopes, `{ data: [], limit, page, total_results, total_pages }` list envelopes, and the canonical `{ status, statusText, errors: [{ message, code }] }` error envelope.

Default port: `4835`

## Quick start

Start the server:

```js
import { BeehiivServer } from "./services/beehiiv/src/server.js";

const server = new BeehiivServer(4835);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it (Bearer auth):

```js
await fetch("http://127.0.0.1:4835/v2/publications/pub_parlel/subscriptions", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-beehiiv-key", "Content-Type": "application/json" },
  body: JSON.stringify({ email: "subscriber@parlel.dev" }),
});
// => { data: { id, email, status: "active", subscription_tier: "free", ... } }
```

Created posts are captured and inspectable via `/__parlel/*`.

## Access via MCP / preview URL

When run under the parlel pool, this service is reachable through the MCP gateway
and a preview URL at `http://127.0.0.1:4835`. Use `BEEHIIV_BASE_URL` to point
clients/agents at it. Captured posts live at `GET /__parlel/messages`.

## Implemented operations

All `/v2/*` routes require Bearer auth. State is in-memory and ephemeral.

### Publications

- `GET /v2/publications` — list publications (a seeded `pub_parlel` exists).
- `GET /v2/publications/:pubId` — retrieve a publication.

### Subscriptions

- `POST /v2/publications/:pubId/subscriptions` — create or upsert a subscription (`email` required). Returns `200`.
- `GET /v2/publications/:pubId/subscriptions` — list subscriptions.
- `GET /v2/publications/:pubId/subscriptions/:subscriptionId` — get a subscription by ID.
- `GET /v2/publications/:pubId/subscriptions/by_email/:email` — get a subscription by email.
- `PUT /v2/publications/:pubId/subscriptions/:subscriptionId` — update a subscription (supports `email`, `tier`, `unsubscribe`, `custom_fields`).
- `PUT /v2/publications/:pubId/subscriptions/by_email/:email` — update a subscription by email.
- `DELETE /v2/publications/:pubId/subscriptions/:subscriptionId` — delete a subscription (`204`).

### Posts

- `POST /v2/publications/:pubId/posts` — create a post (`title` required); captured.
- `GET /v2/publications/:pubId/posts` — list posts.
- `GET /v2/publications/:pubId/posts/:postId` — get a post by ID.
- `PATCH /v2/publications/:pubId/posts/:postId` — update a post.
- `DELETE /v2/publications/:pubId/posts/:postId` — delete a post (`204`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/messages` — list captured posts (`{ messages, count }`).
- `GET /__parlel/messages/:id` — fetch a single captured post.
- `DELETE /__parlel/messages` — clear only the captured mailbox.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Publications (list/get) | ✅ Supported |
| Subscriptions CRUD (create/upsert/list/get/by_email/update/delete) | ✅ Supported |
| Subscriptions required fields (`subscription_premium_tier_names`, `utm_channel`, `utm_term`, `utm_content`, `referral_code`) | ✅ Supported |
| Posts (create/list/get/update/delete) | ✅ Supported |
| Post required fields (`authors`, `slug`, `web_url`, `audience`, `platform`, `subject_line`, etc.) | ✅ Supported |
| Correct error envelope (`status`/`statusText`/`errors[{message,code}]`) | ✅ Supported |
| Captured post inspection | ✅ Supported (parlel extension) |
| Cursor-based pagination (`has_more`/`next_cursor`) | ◐ Envelope fields returned but single-page only |
| Actual newsletter delivery / SMTP | ✓ By design — Captured in-memory for inspection — no real messages sent |
| Segments / automations / referral program / webhooks / custom fields API | ⟳ Roadmap |
| Real API-key validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the real beehiiv envelope:

```json
{
  "status": 400,
  "statusText": "Bad Request",
  "errors": [{ "message": "A valid email is required.", "code": "bad_request" }]
}
```

| Status | Code | When |
| --- | --- | --- |
| `401` | `unauthorized` | missing/invalid Bearer auth |
| `400` | `bad_request` | invalid/missing `email` or `title`, malformed JSON body |
| `404` | `not_found` | unknown publication / subscription / post / endpoint |
| `405` | `method_not_allowed` | unsupported HTTP method on a valid route |

## Manifest

See `services/beehiiv/manifest.json`:

- name: `beehiiv`, image: `parlel/beehiiv:1.0`
- port: `4835`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `BEEHIIV_API_KEY`, `BEEHIIV_PUBLICATION_ID`, `BEEHIIV_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
BEEHIIV_API_KEY=parlel-beehiiv-key
BEEHIIV_PUBLICATION_ID=pub_parlel
BEEHIIV_BASE_URL=http://localhost:4835
```

<!-- parlel:testenv:end -->
