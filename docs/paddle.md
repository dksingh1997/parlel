# Paddle

Lightweight, dependency-free, in-memory fake of the Paddle Billing API for testing merchant-of-record billing integrations.

Default port: `4765`

## Quick start

```js
import { PaddleServer } from "./services/paddle/src/server.js";

const server = new PaddleServer(4765);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Call the API with a Bearer token; every response is wrapped in `{ data, meta }`:

```js
const res = await fetch("http://127.0.0.1:4765/products", {
  method: "POST",
  headers: { Authorization: "Bearer pdl_test_parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Pro Plan", tax_category: "standard" }),
}).then((r) => r.json());
// res.data.id => pro_...
```

## Implemented operations

All resource routes require an `Authorization: Bearer` header (any non-empty
token; missing auth returns `403`, matching Paddle). JSON request/response.
Single responses are `{ data: {...}, meta: { request_id } }`; lists are
`{ data: [...], meta: { request_id, pagination } }`. State is in-memory and
ephemeral.

### Products / Prices / Customers / Transactions / Subscriptions

Each resource (`/products`, `/prices`, `/customers`, `/transactions`,
`/subscriptions`) supports:

- `POST /{resource}` — create (`201`, prefixed id: `pro_`, `pri_`, `ctm_`, `txn_`, `sub_`).
- `GET /{resource}` — list (`{ data: [...], meta: { pagination } }`).
- `GET /{resource}/:id` — retrieve.
- `PATCH /{resource}/:id` — update.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`PADDLE_BASE_URL`, e.g. `http://127.0.0.1:4765`). Pass `Authorization: Bearer`

clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `products` create / list / get / update | ✅ Supported |
| `prices` create / list / get / update | ✅ Supported |
| `customers` create / list / get / update | ✅ Supported |
| `transactions` create / list / get / update | ✅ Supported |
| `subscriptions` create / list / get / update | ✅ Supported |
| `{ data, meta }` envelope + prefixed ids | ✅ Supported |
| Pagination cursors (`meta.pagination`) | ◐ Returned, but all rows listed |
| Subscription lifecycle ops (pause/resume/cancel) | ◐ Update via PATCH only |
| Adjustments / reports / notifications | ⟳ Roadmap |
| Webhooks / signature verification | ⟳ Roadmap — event emission planned |
| Real charging / MoR tax | ⟳ Roadmap — Intentionally unsupported |
| Token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

```json
{ "error": { "type": "request_error", "code": "entity_not_found", "detail": "Entity not found" }, "meta": { "request_id": "..." } }
```

| Status | When |
| --- | --- |
| `400` | malformed body |
| `403` | missing Bearer token (`authentication_missing`) |
| `404` | unknown id / resource |
| `405` | method not allowed |

## Manifest

See `services/paddle/manifest.json`:

- name: `paddle`, image: `parlel/paddle:1.0`
- port: `4765`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `PADDLE_API_KEY`, `PADDLE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PADDLE_API_KEY=pdl_test_parlel
PADDLE_BASE_URL=http://localhost:4765
```

<!-- parlel:testenv:end -->
