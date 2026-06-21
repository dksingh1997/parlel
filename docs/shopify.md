# Shopify

Lightweight, dependency-free, in-memory fake of the Shopify Admin REST API (`2024-01`) for testing code that talks to Shopify.

Default port: `4758`

## Quick start

```js
import { ShopifyServer } from "./services/shopify/src/server.js";

const server = new ShopifyServer(4758);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your client at the fake and use any access token:

```js
const res = await fetch("http://127.0.0.1:4758/admin/api/2024-01/products.json", {
  method: "POST",
  headers: {
    "X-Shopify-Access-Token": "shpat_parlel",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ product: { title: "Snowboard", vendor: "Parlel" } }),
});
// => 201 { product: { id, title, handle, status, variants: [...], ... } }
```

## Implemented operations

All `/admin/api/2024-01/*` routes require an `X-Shopify-Access-Token` header
(any non-empty token, or `Authorization: Basic` for private apps). Resources are
wrapped under the singular key on read/write and the plural key on list. State
is in-memory and ephemeral.

### Products — `/admin/api/2024-01/products.json`

- `GET /products.json` — list (`{ products: [...] }`). Honors `ids` (comma-separated),
  `limit` (≤ 250), and `since_id` query params.
- `GET /products/count.json` — count (`{ count: N }`).
- `POST /products.json` — create (`201 { product: {...} }`), body `{ product: {...} }`.
  A blank/missing `title` returns `422 { errors: { title: ["can't be blank"] } }`.
  The created product is enriched with the server-derived fields the real API
  returns: `handle` (slugified from `title`), `status` (`active`),
  `published_scope` (`web`), `tags`, a default `variants` entry
  (`title: "Default Title"`, `price: "0.00"`, `admin_graphql_api_id`), a default
  `options` entry (`name: "Title"`), `images: []`, and `image: null`.
- `GET /products/:id.json` — retrieve.
- `PUT /products/:id.json` — update.
- `DELETE /products/:id.json` — delete (`200 {}`).

### Orders — `/admin/api/2024-01/orders.json`

- `GET` / `POST` / `GET :id` / `PUT :id` / `DELETE :id` — same CRUD shape, wrapped in
  `{ order }` / `{ orders }`. List honors `ids` / `limit` / `since_id`;
  `GET /orders/count.json` returns `{ count }`. Created orders gain `name` (e.g.
  `#1001`), `currency`, `financial_status` (`pending`), and `total_price`.

### Customers — `/admin/api/2024-01/customers.json`

- `GET` / `POST` / `GET :id` / `PUT :id` / `DELETE :id` — wrapped in
  `{ customer }` / `{ customers }`. List honors `ids` / `limit` / `since_id`;
  `GET /customers/count.json` returns `{ count }`. A customer with neither an
  `email` nor a name returns `422 { errors: {...} }`; a duplicate `email` returns
  `422 { errors: { email: ["has already been taken"] } }`. Created customers are
  enriched with `state` (`enabled`), `total_spent` (`"0.00"`), `orders_count`,
  `tax_exempt`, `verified_email`, `tags`, `currency`, `email_marketing_consent`,
  and `admin_graphql_api_id`.

### Shop — `/admin/api/2024-01/shop.json`

- `GET /shop.json` — returns store metadata (`{ shop: {...} }`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`SHOPIFY_BASE_URL`, e.g. `http://127.0.0.1:4758`). Point your Admin REST client
at that host and pass any `X-Shopify-Access-Token`. MCP agents can call any
documented endpoint; `/__parlel/reset` clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `products` CRUD | ✅ Supported |
| `orders` CRUD | ✅ Supported |
| `customers` CRUD | ✅ Supported |
| `shop.json` | ✅ Supported |
| `{ resource: {...} }` wrap / plural list shape | ✅ Supported |
| Numeric resource ids + `admin_graphql_api_id` | ✅ Supported |
| Required-field validation → `422 { errors: { field: [...] } }` | ✅ Supported (product `title`, customer email-or-name + unique email) |
| Server-derived create fields (product `handle`/`status`/default `variants`/`options`; customer `state`/`total_spent`/`orders_count`) | ✅ Supported |
| List filters `ids` / `limit` / `since_id` | ✅ Supported |
| `count.json` endpoints | ✅ Supported |
| GraphQL Admin API | ⟳ Roadmap — REST only |
| Webhooks / fulfillment / inventory / metafields | ⟳ Roadmap |
| `Link`-header cursor pagination | ⟳ Roadmap |
| Variants/images side-effects, price rules, taxes | ◐ Stored as-is, not computed |
| Rate limiting / leaky bucket (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| Token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Auth, routing, and not-found errors use the string envelope:

```json
{ "errors": "Not Found" }
```

Validation errors use the field-keyed envelope, matching the real Admin REST API:

```json
{ "errors": { "title": ["can't be blank"] } }
```

| Status | When |
| --- | --- |
| `400` | malformed JSON body |
| `401` | missing `X-Shopify-Access-Token` |
| `404` | unknown id or endpoint |
| `405` | method not allowed |
| `422` | failed validation (missing required field, duplicate unique value) |

## Manifest

See `services/shopify/manifest.json`:

- name: `shopify`, image: `parlel/shopify:1.0`
- port: `4758`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_SHOP`, `SHOPIFY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SHOPIFY_ACCESS_TOKEN=shpat_parlel
SHOPIFY_SHOP=parlel-test.myshopify.com
SHOPIFY_BASE_URL=http://localhost:4758
```

<!-- parlel:testenv:end -->
