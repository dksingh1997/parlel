# WooCommerce

Lightweight, dependency-free, in-memory fake of the WooCommerce REST API v3 (`/wp-json/wc/v3/...`).

Default port: `4759`

## Quick start

```js
import { WoocommerceServer } from "./services/woocommerce/src/server.js";

const server = new WoocommerceServer(4759);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the official `@woocommerce/woocommerce-rest-api` client at the fake:

```js
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

const api = new WooCommerceRestApi({
  url: "http://127.0.0.1:4759",
  consumerKey: "ck_parlel",
  consumerSecret: "cs_parlel",
  version: "wc/v3",
});

const { data } = await api.post("products", { name: "Beanie", regular_price: "9.99" });
// data.id => generated numeric id
```

## Implemented operations

All `/wp-json/wc/v3/*` routes require auth: Basic (consumer key/secret),
`Authorization: Bearer`, or query params `consumer_key` + `consumer_secret`
(any non-empty credential is accepted). JSON request/response. State is
in-memory and ephemeral.

### Products / Orders / Customers — `/wp-json/wc/v3/{resource}`

Each resource supports the full CRUD surface:

- `GET /{resource}` — list (array).
- `POST /{resource}` — create (`201`, generated numeric `id`, `date_created`).
- `GET /{resource}/:id` — retrieve.
- `PUT /{resource}/:id` — update.
- `DELETE /{resource}/:id` — delete (returns the deleted record).

Orders default to `status: "pending"` and products to `status: "publish"` when
unspecified.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`WOOCOMMERCE_BASE_URL`, e.g. `http://127.0.0.1:4759`). Point the WooCommerce
REST client `url` at that host and pass any consumer key/secret. MCP agents can
call any documented endpoint; `/__parlel/reset` clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `products` CRUD | ✅ Supported |
| `orders` CRUD | ✅ Supported |
| `customers` CRUD | ✅ Supported |
| Basic / Bearer / query-param auth | ✅ Supported |
| Numeric ids, `date_created` / `date_modified` | ✅ Supported |
| Batch endpoints (`/batch`) | ⟳ Roadmap |
| Coupons / refunds / reports / settings | ⟳ Roadmap |
| OAuth 1.0a signature verification | ✓ By design — Structurally faithful tokens; cryptographic verification is skipped for local use |
| Line-item totals / tax computation | ◐ Stored as-is, not computed |
| Pagination headers (`X-WP-Total`) | ✓ By design — Not emitted |
| Credential validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

```json
{ "code": "woocommerce_rest_product_invalid_id", "message": "Invalid ID.", "data": { "status": 404 } }
```

| Status | When |
| --- | --- |
| `400` | malformed JSON body |
| `401` | missing credentials |
| `404` | unknown id or route (`rest_no_route`) |
| `405` | method not allowed |

## Manifest

See `services/woocommerce/manifest.json`:

- name: `woocommerce`, image: `parlel/woocommerce:1.0`
- port: `4759`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`, `WOOCOMMERCE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WOOCOMMERCE_CONSUMER_KEY=ck_parlel
WOOCOMMERCE_CONSUMER_SECRET=cs_parlel
WOOCOMMERCE_BASE_URL=http://localhost:4759
```

<!-- parlel:testenv:end -->
