# Lemon Squeezy

Lightweight, dependency-free, in-memory Lemon Squeezy API fake for testing code
that uses the Lemon Squeezy **JSON:API** REST surface (and the official
`@lemonsqueezy/lemonsqueezy.js` SDK).

Default port: `4873`

## Quick start

```js
import { LemonSqueezyServer } from "./services/lemon-squeezy/src/server.js";

const server = new LemonSqueezyServer(4873);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `Authorization: Bearer <token>` header (any non-empty
value accepted) and the JSON:API `Accept` header:

```js
const res = await fetch("http://127.0.0.1:4873/v1/products", {
  headers: {
    Authorization: "Bearer parlel",
    Accept: "application/vnd.api+json",
  },
});
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4873`) and through the parlel MCP
server as the `lemon-squeezy` tool. Set
`LEMONSQUEEZY_BASE_URL=http://127.0.0.1:4873` and any non-empty
`LEMONSQUEEZY_API_KEY`.

## Implemented operations

- `GET /v1/products`, `GET /v1/products/:id` — products (one seeded).
- `GET /v1/orders` — orders (one seeded).
- `GET|POST /v1/checkouts` — list / create a checkout (`attributes.url` returned).
- `GET /v1/subscriptions` — subscriptions (one seeded).
- `GET /v1/stores` — stores (one seeded).
- `GET /v1/users/me` — the authenticated user.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Response shapes (JSON:API)

Single resource:

```json
{ "jsonapi": { "version": "1.0" }, "data": { "type": "products", "id": "1", "attributes": {} }, "links": {} }
```

Collection:

```json
{ "jsonapi": { "version": "1.0" }, "meta": { "page": { "currentPage": 1, "total": 1, ... } }, "data": [ ... ], "links": {} }
```

Errors use `{ "jsonapi": {...}, "errors": [{ "status", "title", "detail" }] }`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Products / orders / subscriptions / stores list+get | ✅ Supported |
| Checkouts list / create | ✅ Supported |
| `users/me` | ✅ Supported |
| JSON:API single + collection envelopes | ✅ Supported |
| Bearer auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| `include` / `filter` / sparse fieldsets | ⟳ Roadmap — Ignored |
| Real cursor pagination | ◐ Single page only |
| Webhooks / license keys / discounts | ⟳ Roadmap |

## Manifest

See `services/lemon-squeezy/manifest.json` — name `lemon-squeezy`, port `4873`,
protocol `http`, healthcheck `/health`, env `LEMONSQUEEZY_API_KEY`,
`LEMONSQUEEZY_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
LEMONSQUEEZY_API_KEY=parlel
LEMONSQUEEZY_BASE_URL=http://localhost:4873
```

<!-- parlel:testenv:end -->
