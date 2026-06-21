# ConvertKit (Kit)

Lightweight, dependency-free, in-memory fake of the ConvertKit (Kit) **v3** HTTP REST API for testing application code that talks to ConvertKit directly with the `axios` HTTP client (the documented integration path). Speaks the exact plain-JSON wire protocol the real service uses, with zero cost and zero side effects. State is in-memory, ephemeral, and resettable.

Default port: `4667`

## Quick start

Start the server:

```js
import { ConvertkitServer } from "./services/convertkit/src/server.js";

const server = new ConvertkitServer(4667);
await server.start();
// ... run your app / tests ...
await server.stop();
```

Point the real `axios` client at it. ConvertKit's v3 API lives under `/v3` and authenticates with an `api_key` (public) or `api_secret` (private), supplied either as a **query-string parameter** or a **JSON body field** — exactly as the real API accepts them:

```js
import axios from "axios";

const ck = axios.create({
  baseURL: "http://127.0.0.1:4667/v3", // point at the parlel fake
  headers: { "Content-Type": "application/json" },
});

// Public endpoint: subscribe an email to a form (api_key in the body)
const { data } = await ck.post(`/forms/${formId}/subscribe`, {
  api_key: process.env.CONVERTKIT_API_KEY,
  email: "ada@parlel.test",
  first_name: "Ada",
  fields: { city: "London" },
});
// data.subscription.subscriber.id => a generated subscriber id

// Private endpoint: list subscribers (api_secret as a query param)
const res = await ck.get("/subscribers", {
  params: { api_secret: process.env.CONVERTKIT_API_SECRET },
});
// res.data.total_subscribers, res.data.subscribers[]
```

## Authentication

| Credential | Used for | Supplied as |
| --- | --- | --- |
| `api_key` (public) | Listing forms/sequences/tags/custom fields, subscribe endpoints | query param or JSON body field |
| `api_secret` (private) | Subscriber data, broadcasts, purchases, webhooks, tag/custom-field writes, subscriptions lists | query param or JSON body field |

Default credentials (from `manifest.json`):

- `api_key`: `parlel_test_public_api_key`
- `api_secret`: `parlel_test_secret_api_key`

A missing/wrong credential returns `401` with `{ "error": "Authorization Failed", "message": "..." }`. Supplying only `api_key` to a secret-only endpoint also returns `401`.

## Implemented operations

### Account (api_secret)
- `GET /v3/account` — account name, primary email, plan type
- `GET /v3/account/creator_profile` — creator profile
- `GET /v3/account/growth_stats` — subscriber growth stats

### Forms
- `GET /v3/forms` (api_key) — list forms
- `POST /v3/forms/{id}/subscribe` (api_key) — subscribe/upsert an email to a form (accepts `email`, `first_name`, `fields`, `tags`, `referrer`)
- `GET /v3/forms/{id}/subscriptions` (api_secret) — list form subscriptions (paginated)

### Sequences (a.k.a. Courses)
- `GET /v3/sequences` (api_key) — list sequences (returned under the `courses` key, matching the real API)
- `POST /v3/sequences/{id}/subscribe` (api_key) — subscribe/upsert an email to a sequence
- `GET /v3/sequences/{id}/subscriptions` (api_secret) — list sequence subscriptions (paginated)

### Tags
- `GET /v3/tags` (api_key) — list tags
- `POST /v3/tags` (api_secret) — create a tag (single object) or many (array) — returns existing tag for duplicate names
- `POST /v3/tags/{id}/subscribe` (api_key) — tag a subscriber by email
- `POST /v3/tags/{id}/unsubscribe` (api_secret) — remove a tag from a subscriber by email
- `GET /v3/tags/{id}/subscriptions` (api_secret) — list tag subscriptions (paginated)

### Subscribers
- `GET /v3/subscribers` (api_secret) — list subscribers, filterable by `email_address`, paginated (`total_subscribers`, `page`, `total_pages`)
- `GET /v3/subscribers/{id}` (api_secret) — fetch a subscriber
- `PUT /v3/subscribers/{id}` (api_secret) — update `first_name`, `email_address`, `fields`
- `GET /v3/subscribers/{id}/tags` (api_secret) — list a subscriber's tags
- `PUT /v3/unsubscribe` (api_secret) — unsubscribe an email (sets `state` → `cancelled`)

### Custom Fields
- `GET /v3/custom_fields` (api_key) — list custom fields
- `POST /v3/custom_fields` (api_secret) — create one (`label`) or many (`custom_fields: [...]`); derives `key` + `name`
- `PUT /v3/custom_fields/{id}` (api_secret) — rename a custom field (returns `204`)
- `DELETE /v3/custom_fields/{id}` (api_secret) — delete a custom field (returns `204`)

### Broadcasts (api_secret)
- `GET /v3/broadcasts` — list broadcasts (id/subject/created_at)
- `POST /v3/broadcasts` — create a broadcast
- `GET /v3/broadcasts/{id}` — fetch a broadcast
- `PUT /v3/broadcasts/{id}` — update a broadcast
- `DELETE /v3/broadcasts/{id}` — delete a broadcast (returns `204`)
- `GET /v3/broadcasts/{id}/stats` — broadcast stats envelope

### Webhooks (api_secret)
- `POST /v3/automations/hooks` — create a webhook rule (`target_url`, `event`) → `{ rule: {...} }`
- `DELETE /v3/automations/hooks/{id}` — delete a webhook → `{ success: true }`

### Purchases (api_secret)
- `GET /v3/purchases` — list purchases (paginated: `total_purchases`, `page`, `total_pages`)
- `GET /v3/purchases/{id}` — fetch a purchase
- `POST /v3/purchases` — create a purchase (upserts the buyer as a subscriber)

### parlel control / inspection (unauthenticated)
- `GET /health` — `{ "status": "ok" }`
- `POST /__parlel/reset` — wipe all state (re-seeds default forms/sequence)
- `GET /__parlel/state` — counts of every resource
- `POST /__parlel/seed/{form|sequence|tag|subscriber}` — seed a resource for test setup

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Forms list + subscribe + subscriptions | ✅ Supported |
| Sequences (courses) list + subscribe + subscriptions | ✅ Supported |
| Tags CRUD (create/list/subscribe/unsubscribe/subscriptions) | ✅ Supported |
| Subscribers list/get/update/unsubscribe/tags | ✅ Supported |
| Custom fields CRUD | ✅ Supported |
| Broadcasts CRUD + stats | ✅ Supported |
| Webhooks (automations/hooks) create + delete | ✅ Supported |
| Purchases create/list/get | ✅ Supported |
| Account / creator profile / growth stats | ✅ Supported |
| `api_key` / `api_secret` auth (query param or body) | ✅ Supported |
| Email-based subscriber upsert across all subscribe paths | ✅ Supported |
| Pagination envelopes (`page`, `total_pages`, `total_*`) | ✅ Supported (single-page, deterministic) |
| Real email delivery / sending broadcasts | ⟳ Roadmap — Not supported (no side effects) |
| OAuth 2.0 / Kit v4 API surface | ⟳ Roadmap — Not supported (this fake targets v3) |
| Real webhook delivery to `target_url` | ⟳ Roadmap — Not supported (stored only) |
| Rate limiting / `429` throttling | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| Stats analytics (real open/click rates) | ✓ By design — Intentional for a local, zero-cost test emulator |

## Error codes & shapes

Errors use the ConvertKit error envelope:

```json
{ "error": "<Title>", "message": "<detail>" }
```

| Status | When |
| --- | --- |
| `200` | Successful read/subscribe/update |
| `201` | Resource created (tags, custom fields, broadcasts, purchases) |
| `204` | Successful delete / custom-field update (no body) |
| `400` | Bad Request — invalid email, blank name/label, missing `target_url`, malformed JSON |
| `401` | Authorization Failed — missing/invalid `api_key` or `api_secret` |
| `404` | Not Found — unknown resource id or path |
| `405` | Method Not Allowed — unsupported method on a known resource |
| `422` | Unprocessable Entity — invalid purchase payload (missing `transaction_id`, invalid email) |
| `500` | Internal Server Error — unexpected failure |

All responses set `Content-Type: application/json; charset=utf-8` and permissive CORS headers, and carry a `server: parlel-convertkit` header.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CONVERTKIT_API_KEY=parlel_test_public_api_key
CONVERTKIT_API_SECRET=parlel_test_secret_api_key
CONVERTKIT_BASE_URL=http://localhost:4667
CONVERTKIT_API_BASE_URL=http://localhost:4667/v3
```

<!-- parlel:testenv:end -->
