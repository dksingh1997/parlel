# Stripe

Lightweight, dependency-free, in-memory Stripe REST API fake for testing code that uses the real `stripe` SDK (and the language-agnostic Stripe REST API).

Default port: `4757`

## Quick start

Start the server:

```js
import { StripeServer } from "./services/stripe/src/server.js";

const server = new StripeServer(4757);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `stripe` client at it. The Stripe SDK reads its host from configuration, so override the base URL to the fake:

```js
import Stripe from "stripe";

const stripe = new Stripe("sk_test_parlel", {
  host: "127.0.0.1",
  port: 4757,
  protocol: "http",
});

const customer = await stripe.customers.create({
  email: "jane@parlel.dev",
  metadata: { plan: "pro" },
});
// customer.id => cus_...
```

Stripe sends requests as `application/x-www-form-urlencoded` (including PHP-style
bracket notation such as `metadata[key]=value`) and receives JSON. The fake
parses both form-encoded and JSON bodies.

## Implemented operations

All `/v1/*` routes require an `Authorization: Bearer sk_test_...` header (any
non-empty bearer/basic token is accepted, matching a local test key). State is
in-memory and ephemeral.

### Customers

- `POST /v1/customers` — create a customer (`200 { id: cus_..., object: "customer", ... }`).
- `GET /v1/customers` — list customers (`{ object: "list", data, has_more, url }`). Supports cursor pagination: `limit` (1–100, default 10), `starting_after`, `ending_before`. All list endpoints share this behavior.
- `GET /v1/customers/:id` — retrieve.
- `POST /v1/customers/:id` — update.
- `DELETE /v1/customers/:id` — delete (`{ id, object, deleted: true }`).

### Charges

- `POST /v1/charges` — create a charge (`ch_...`).
- `GET /v1/charges` — list.
- `GET /v1/charges/:id` — retrieve.
- `POST /v1/charges/:id` — update description/metadata.

### Payment intents

- `POST /v1/payment_intents` — create (`pi_...`, returns `client_secret`). `amount` required. Default `status` is `requires_payment_method` (real Stripe automatic-confirmation default); passing `confirm=true` returns `status: succeeded`.
- `GET /v1/payment_intents` — list.
- `GET /v1/payment_intents/:id` — retrieve.
- `POST /v1/payment_intents/:id` — update.
- `POST /v1/payment_intents/:id/confirm` — confirm. Automatic-capture intents become `succeeded`; `capture_method=manual` intents become `requires_capture`.
- `POST /v1/payment_intents/:id/capture` — capture a `requires_capture` intent (`status: succeeded`, sets `amount_received`).
- `POST /v1/payment_intents/:id/cancel` — cancel (sets `cancellation_reason`, `canceled_at`).

### Refunds

- `POST /v1/refunds` — create a refund (`re_...`); flips the linked charge to refunded.
- `GET /v1/refunds` — list.
- `GET /v1/refunds/:id` — retrieve.
- `POST /v1/refunds/:id` — update refund `metadata`.

### Products & prices

- `POST /v1/products` — create (`prod_...`). `name` required.
- `GET /v1/products` / `GET /v1/products/:id` — list / retrieve.
- `POST /v1/products/:id` — update. `DELETE /v1/products/:id` — delete.
- `POST /v1/prices` — create (`price_...`). Requires `currency`, a `product` reference, and `unit_amount` (or `unit_amount_decimal`); missing → `400 parameter_missing`.
- `GET /v1/prices` / `GET /v1/prices/:id` — list / retrieve.

### Balance

- `GET /v1/balance` — returns the `balance` object with `available` / `pending`.

### Checkout sessions

- `POST /v1/checkout/sessions` — create (`cs_...`, returns hosted `url`).
- `GET /v1/checkout/sessions` / `GET /v1/checkout/sessions/:id` — list / retrieve.

### Service & inspection operations (parlel extensions, not part of Stripe)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

When run inside a parlel sandbox the service is reachable at its preview URL
(the `STRIPE_BASE_URL` env var, e.g. `http://127.0.0.1:4757`). Point the
`stripe` SDK `host`/`port`/`protocol` (or your `STRIPE_BASE_URL`) at that
address. MCP-driven agents can call any documented endpoint directly; the
`/__parlel/reset` control endpoint clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `customers.*` (create/list/get/update/delete) | ✅ Supported — response includes always-present fields (`balance`, `delinquent`, `tax_exempt`, `default_source`, `invoice_settings`, ...) |
| `charges.*` (create/list/get/update) | ◐ Always `status: succeeded`, `paid: true`; `receipt_url`/`outcome`/`payment_method_details` returned as `null` (no real card processing) |
| `paymentIntents.*` (create/list/get/update/confirm/cancel/capture) | ✅ Supported — create returns `requires_payment_method`; manual-capture flow (`requires_capture` → `capture`) supported |
| `refunds.*` (create/list/get/update) | ✅ Supported |
| `products.*` (create/list/get/update/delete) | ✅ Supported |
| `prices.*` (create/list/get/update) | ✅ Supported — `create` validates required `currency`/`product`/`unit_amount` |
| `balance.retrieve` | ✅ Supported — `available`/`pending` arrays (omits feature-gated `instant_available`/`connect_reserved`/`issuing`) |
| `checkout.sessions.*` (create/list/get/expire) | ◐ `line_items` echoed verbatim; `amount_total`/`amount_subtotal`/`payment_intent` returned as `null` (no real session computation) |
| List cursor pagination (`limit`, `starting_after`, `ending_before`) | ✅ Supported |
| Form-encoded (bracket notation) + JSON request parsing | ✅ Supported |
| Deterministic prefixed ids (`cus_`, `ch_`, `pi_`, `re_`, `prod_`, `price_`, `cs_`) | ✅ Supported |
| Error envelope (`{error:{type,code,doc_url,message,param}}`) incl. 401 `WWW-Authenticate` header | ✅ Supported |
| Webhooks / signed events | ⟳ Roadmap — event emission planned |
| PaymentMethods / SetupIntents / Tokens (`pm_`/`tok_` flows) | ⟳ Roadmap — these endpoints return `404` |
| Subscriptions / invoices / billing schedules | ⟳ Roadmap |
| Real card processing / 3DS / SCA | ✓ By design — Always succeeds deterministically — no real funds move |
| Idempotency-Key 24h enforcement | ✓ By design — Not enforced |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| Bearer/Basic-token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — invalid-format keys are NOT rejected, no real secrets needed |

## Error codes & shapes

Errors use the Stripe envelope (key order `type, code, doc_url, message, param`):

```json
{ "error": { "type": "invalid_request_error", "code": "resource_missing", "message": "No such customer: 'cus_nope'", "param": "id" } }
```

The `401` response additionally sets a `WWW-Authenticate: Basic realm="Stripe"` header and carries `code: "authentication_required"` plus a `doc_url`.

| Status | When |
| --- | --- |
| `400` | missing required param (e.g. `amount`, `name`, price `currency`/`product`/`unit_amount`), invalid body (`code: parameter_missing`) |
| `401` | no `Authorization` header (`code: authentication_required`, `WWW-Authenticate` header) |
| `404` | unknown resource id (`code: resource_missing`), unknown endpoint, or unsupported method on a path (matching real Stripe, which returns `404 Unrecognized request URL` rather than `405`) |

## Manifest

See `services/stripe/manifest.json`:

- name: `stripe`, image: `parlel/stripe:1.0`
- port: `4757`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `STRIPE_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
STRIPE_API_KEY=sk_test_parlel
STRIPE_SECRET_KEY=sk_test_parlel
STRIPE_BASE_URL=http://localhost:4757
```

<!-- parlel:testenv:end -->
