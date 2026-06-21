# Square

Lightweight, dependency-free, in-memory fake of the Square API (v2) for testing payment, customer, and order integrations.

Default port: `4766`

## Quick start

```js
import { SquareServer } from "./services/square/src/server.js";

const server = new SquareServer(4766);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Call the API with a Bearer access token; single responses are wrapped in the
singular key and lists in the plural key:

```js
const res = await fetch("http://127.0.0.1:4766/v2/payments", {
  method: "POST",
  headers: { Authorization: "Bearer parlel-square-token", "Content-Type": "application/json", "Square-Version": "2024-01-18" },
  body: JSON.stringify({
    idempotency_key: "unique-key",
    amount_money: { amount: 1000, currency: "USD" },
    source_id: "cnon:card-nonce-ok",
  }),
}).then((r) => r.json());
// res.payment.id => generated, status "COMPLETED"
```

## Implemented operations

All `/v2/*` routes require an `Authorization: Bearer` header (any non-empty
token). JSON request/response. State is in-memory and ephemeral.

### Payments — `/v2/payments`

- `POST /v2/payments` — create (`{ payment: {...} }`, `status: "COMPLETED"`). `idempotency_key` required; repeating a key replays the original response.
- `GET /v2/payments` — list (`{ payments: [...] }`).
- `GET /v2/payments/:id` — retrieve.

### Customers — `/v2/customers`

- `POST /v2/customers` — create (`{ customer: {...} }`).
- `GET /v2/customers` — list (`{ customers: [...] }`).
- `GET /v2/customers/:id` — retrieve.
- `PUT /v2/customers/:id` — update (`version` increments).
- `DELETE /v2/customers/:id` — delete.

### Orders — `/v2/orders`

- `POST /v2/orders` — create (body `{ order: {...} }`, `state: "OPEN"`).
- `GET /v2/orders/:id` — retrieve.
- `POST /v2/orders/search` — list all orders (`{ orders: [...] }`).

### Locations — `/v2/locations`

- `GET /v2/locations` — list (`{ locations: [...] }`, a seeded default location).
- `GET /v2/locations/:id` — retrieve.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`SQUARE_BASE_URL`, e.g. `http://127.0.0.1:4766`). Pass `Authorization: Bearer`
with any access token. MCP agents can call any documented endpoint;
`/__parlel/reset` clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `payments` create / list / get | ✅ Supported |
| `idempotency_key` replay | ✅ Supported |
| `customers` create / list / get / update / delete | ✅ Supported |
| `orders` create / get / search | ✅ Supported |
| `locations` list / get | ✅ Supported |
| `{ resource }` / `{ resources }` envelopes | ✅ Supported |
| Refunds / disputes / payouts / catalog | ⟳ Roadmap |
| Cards-on-file / gift cards / loyalty | ⟳ Roadmap |
| Webhooks / signature verification | ⟳ Roadmap — event emission planned |
| Real card processing | ✓ By design — Always succeeds deterministically — no real funds move |
| Pagination cursors | ◐ All rows returned |
| Token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Errors use the Square envelope:

```json
{ "errors": [{ "category": "INVALID_REQUEST_ERROR", "code": "MISSING_REQUIRED_PARAMETER", "detail": "...", "field": "idempotency_key" }] }
```

| Status | When |
| --- | --- |
| `400` | malformed body / missing required parameter |
| `401` | missing Bearer token (`AUTHENTICATION_ERROR`) |
| `404` | unknown id / resource |
| `405` | method not allowed |

## Manifest

See `services/square/manifest.json`:

- name: `square`, image: `parlel/square:1.0`
- port: `4766`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `SQUARE_ACCESS_TOKEN`, `SQUARE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SQUARE_ACCESS_TOKEN=parlel-square-token
SQUARE_BASE_URL=http://localhost:4766
```

<!-- parlel:testenv:end -->
