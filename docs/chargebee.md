# Chargebee

Lightweight, dependency-free, in-memory fake of the Chargebee v2 API for testing subscription billing integrations.

Default port: `4764`

## Quick start

```js
import { ChargebeeServer } from "./services/chargebee/src/server.js";

const server = new ChargebeeServer(4764);
await server.start();
// ... run your app/tests ...
await server.stop();
```

`application/x-www-form-urlencoded` request bodies (including bracket notation
such as `subscription[plan_id]=basic`). Responses are JSON wrapped in the
resource name:

```js
const basic = Buffer.from("test_parlel:").toString("base64");
const res = await fetch("http://127.0.0.1:4764/api/v2/customers", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "first_name=Jane&email=jane@parlel.dev",
}).then((r) => r.json());
// res.customer.id => cust_...
```

## Implemented operations

bodies are form-encoded (bracket notation supported); responses are wrapped as
`{ customer: {...} }` and lists as `{ list: [{ customer: {...} }], next_offset }`.
State is in-memory and ephemeral.

### Customers — `/api/v2/customers`

- `POST /api/v2/customers` — create (`cust_...`).
- `GET /api/v2/customers` — list (`{ list: [{ customer }] }`).
- `GET /api/v2/customers/:id` — retrieve.
- `POST /api/v2/customers/:id` — update.

### Subscriptions — `/api/v2/subscriptions`

- `POST` / `GET` / `GET :id` / `POST :id` — CRUD (`sub_...`, default `status: "active"`).
- `POST /api/v2/subscriptions/:id/cancel` — cancel (`status: "cancelled"`).

### Invoices — `/api/v2/invoices`

- `POST` / `GET` / `GET :id` / `POST :id` — CRUD (`inv_...`, default `status: "paid"`).

### Plans — `/api/v2/plans`

- `POST` / `GET` / `GET :id` / `POST :id` — CRUD (id supplied or `plan_...`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`CHARGEBEE_BASE_URL`, e.g. `http://127.0.0.1:4764`). Pass Basic auth with any

`/__parlel/reset` clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `customers` create / list / get / update | ✅ Supported |
| `subscriptions` create / list / get / update / cancel | ✅ Supported |
| `invoices` create / list / get / update | ✅ Supported |
| `plans` create / list / get / update | ✅ Supported |
| Form-encoded (bracket notation) request parsing | ✅ Supported |
| `{ resource: {...} }` wrap / `{ list: [...] }` list shape | ✅ Supported |
| Proration / billing cycles / dunning | ✓ By design — Not computed |
| Hosted pages / portal sessions | ⟳ Roadmap |
| Coupons / addons / item-model entities | ⟳ Roadmap |
| Webhooks | ✓ By design — Not emitted |
| Offset/limit pagination | ◐ `next_offset` returned but all rows listed |
| API-key validity | ✓ By design — Intentional for a local, zero-cost test emulator |

## Error codes & shapes

```json
{ "message": "...", "type": "invalid_request", "api_error_code": "resource_not_found", "http_status_code": 404 }
```

| Status | When |
| --- | --- |
| `400` | malformed body / missing param |
| `401` | missing Basic auth |
| `404` | unknown resource id / route |
| `405` | method not allowed |

## Manifest

See `services/chargebee/manifest.json`:

- name: `chargebee`, image: `parlel/chargebee:1.0`
- port: `4764`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CHARGEBEE_API_KEY`, `CHARGEBEE_SITE`, `CHARGEBEE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CHARGEBEE_API_KEY=test_parlel
CHARGEBEE_SITE=parlel-test
CHARGEBEE_BASE_URL=http://localhost:4764
```

<!-- parlel:testenv:end -->
