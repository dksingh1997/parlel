# PayPal

Lightweight, dependency-free, in-memory fake of the PayPal Orders v2 API (and a minimal Payments surface) for testing checkout flows.

Default port: `4760`

## Quick start

```js
import { PaypalServer } from "./services/paypal/src/server.js";

const server = new PaypalServer(4760);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Exchange client credentials for an access token, then create + capture an order:

```js
const basic = Buffer.from("client_id:client_secret").toString("base64");
const tok = await fetch("http://127.0.0.1:4760/v1/oauth2/token", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
}).then((r) => r.json());

const order = await fetch("http://127.0.0.1:4760/v2/checkout/orders", {
  method: "POST",
  headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] }),
}).then((r) => r.json());
// order.status => "CREATED"
```

## Implemented operations

State is in-memory and ephemeral.

### OAuth — `/v1/oauth2/token`

- `POST /v1/oauth2/token` — requires `Authorization: Basic` (client id/secret). Returns `{ access_token, token_type: "Bearer", expires_in, ... }`.

### Orders v2 — `/v2/checkout/orders`

- `POST /v2/checkout/orders` — create an order (`201`, `status: "CREATED"`, HATEOAS `links`). Bearer required.
- `GET /v2/checkout/orders/:id` — retrieve an order.
- `POST /v2/checkout/orders/:id/capture` — capture (`201`, `status: "COMPLETED"`, `purchase_units[].payments.captures[]`).

### Payments v2 — `/v2/payments`

- `POST /v2/payments` — create a payment/capture record (`201`, `status: "COMPLETED"`).
- `GET /v2/payments/captures/:id` — retrieve a captured payment.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`PAYPAL_BASE_URL`, e.g. `http://127.0.0.1:4760`). Obtain a token via
`/v1/oauth2/token` with any Basic credential, then pass `Authorization: Bearer`.
MCP agents can call any documented endpoint; `/__parlel/reset` clears state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `/v1/oauth2/token` (client credentials) | ✅ Supported |
| Orders v2 create / get / capture | ✅ Supported |
| Payments create / get capture | ✅ Supported |
| HATEOAS `links` on orders | ✅ Supported |
| Bearer + Basic auth | ✅ Supported |
| Authorize-then-capture (separate auth) | ◐ Capture supported; authorize-only not modeled |
| Refunds / voids / disputes | ⟳ Roadmap |
| Subscriptions / billing plans | ⟳ Roadmap |
| Webhooks | ✓ By design — Not emitted |
| Real funds movement / PayPal accounts | ⟳ Roadmap — Intentionally unsupported |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

```json
{ "name": "RESOURCE_NOT_FOUND", "message": "The specified resource does not exist.", "debug_id": "..." }
```

| Status | When |
| --- | --- |
| `400` | malformed body |
| `401` | missing Basic (token) / missing Bearer (API) |
| `404` | unknown order/payment or route |
| `405` | method not allowed |

## Manifest

See `services/paypal/manifest.json`:

- name: `paypal`, image: `parlel/paypal:1.0`
- port: `4760`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PAYPAL_CLIENT_ID=parlel-client-id
PAYPAL_CLIENT_SECRET=parlel-client-secret
PAYPAL_BASE_URL=http://localhost:4760
```

<!-- parlel:testenv:end -->
