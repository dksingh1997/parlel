# Razorpay

Lightweight, dependency-free, in-memory fake of the Razorpay v1 API for testing payment flows.

Default port: `4761`

## Quick start

```js
import { RazorpayServer } from "./services/razorpay/src/server.js";

const server = new RazorpayServer(4761);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the official `razorpay` SDK at the fake (it talks to a configurable host)
or call the REST API directly with Basic auth:

```js
const basic = Buffer.from("rzp_test_parlel:parlel_secret").toString("base64");
const order = await fetch("http://127.0.0.1:4761/v1/orders", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 50000, currency: "INR", receipt: "rcpt#1" }),
}).then((r) => r.json());
// order.id => order_...
```

## Implemented operations

All `/v1/*` routes require Basic auth (`key_id:key_secret`; any non-empty
credential accepted). JSON request/response. State is in-memory and ephemeral.

### Orders — `/v1/orders`

- `POST /v1/orders` — create (`order_...`). `amount` required.
- `GET /v1/orders` — list (`{ entity: "collection", count, items }`).
- `GET /v1/orders/:id` — retrieve.

### Payments — `/v1/payments`

- `POST /v1/payments` — create (`pay_...`, `status: "captured"`).
- `GET /v1/payments` — list.
- `GET /v1/payments/:id` — retrieve.
- `POST /v1/payments/:id/capture` — capture.

### Refunds — `/v1/refunds`

- `POST /v1/refunds` — create (`rfnd_...`); flips the linked payment to refunded.
- `GET /v1/refunds` / `GET /v1/refunds/:id`.

### Customers — `/v1/customers`

- `POST /v1/customers` — create (`cust_...`).
- `GET /v1/customers` / `GET /v1/customers/:id`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`RAZORPAY_BASE_URL`, e.g. `http://127.0.0.1:4761`). Pass Basic auth with any
`key_id:key_secret`. MCP agents can call any documented endpoint;
`/__parlel/reset` clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `orders` create / get / list | ✅ Supported |
| `payments` create / get / list / capture | ✅ Supported |
| `refunds` create / get / list | ✅ Supported |
| `customers` create / get / list | ✅ Supported |
| `order_`, `pay_`, `rfnd_`, `cust_` ids | ✅ Supported |
| `collection` list envelope | ✅ Supported |
| Payment signature verification (checkout) | ✓ By design — Always succeeds deterministically — no real funds move |
| Settlements / virtual accounts / payouts / subscriptions | ⟳ Roadmap |
| Webhooks | ✓ By design — Not emitted |
| Real funds movement | ⟳ Roadmap — Intentionally unsupported (always captured) |
| Credential validity | ✓ By design — Intentional for a local, zero-cost test emulator |

## Error codes & shapes

```json
{ "error": { "code": "BAD_REQUEST_ERROR", "description": "The id provided does not exist", "field": "id" } }
```

| Status | When |
| --- | --- |
| `400` | missing required field (`amount`), unknown id |
| `401` | missing Basic auth |
| `404` | unknown route |
| `405` | method not allowed |

## Manifest

See `services/razorpay/manifest.json`:

- name: `razorpay`, image: `parlel/razorpay:1.0`
- port: `4761`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
RAZORPAY_KEY_ID=rzp_test_parlel
RAZORPAY_KEY_SECRET=parlel_secret
RAZORPAY_BASE_URL=http://localhost:4761
```

<!-- parlel:testenv:end -->
