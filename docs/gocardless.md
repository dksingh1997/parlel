# GoCardless

Lightweight, dependency-free, in-memory GoCardless API fake for testing code that
uses the GoCardless Direct Debit API.

Default port: `4871`

## Quick start

```js
import { GocardlessServer } from "./services/gocardless/src/server.js";

const server = new GocardlessServer(4871);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `Authorization: Bearer <token>` header (any non-empty
value accepted) and a `GoCardless-Version` header:

```js
const res = await fetch("http://127.0.0.1:4871/customers", {
  method: "POST",
  headers: {
    Authorization: "Bearer parlel",
    "GoCardless-Version": "2015-07-06",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ customers: { email: "jane@parlel.dev", given_name: "Jane", family_name: "Doe" } }),
});
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4871`) and through the parlel MCP
server as the `gocardless` tool. Set `GOCARDLESS_BASE_URL=http://127.0.0.1:4871`,
`GOCARDLESS_VERSION`, and any non-empty `GOCARDLESS_ACCESS_TOKEN`.

## Implemented operations

- `GET|POST /customers`, `GET|PUT /customers/:id` — manage customers (`CU…` ids).
- `GET|POST /mandates` — manage mandates (`MD…` ids).
- `GET|POST /payments`, `GET /payments/:id` — manage payments (`PM…` ids).
- `GET /creditors`, `GET /creditors/:id` — list creditors (one is seeded, `CR…`).
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Response shapes

Single resource is wrapped under the resource key:

```json
{ "customers": { "id": "CU...", "email": "..." } }
```

Collections add a `meta` block with cursors:

```json
{ "customers": [ ... ], "meta": { "cursors": { "before": null, "after": null }, "limit": 50 } }
```

## Error envelope

```json
{ "error": { "type": "validation_failed", "code": 422, "message": "...", "errors": [...] } }
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Customers / mandates / payments CRUD | ✅ Supported |
| Creditors list/get | ✅ Supported |
| Wrapped resource + `meta.cursors` shapes | ✅ Supported |
| Bearer + `GoCardless-Version` headers | ◐ Bearer required; version not validated |
| Real Direct Debit collection / scheme submission | ⟳ Roadmap — Status stays `pending_submission` |
| Refunds / payouts / events / webhooks | ⟳ Roadmap |
| Cursor pagination | ◐ Cursors always null (single page) |

## Manifest

See `services/gocardless/manifest.json` — name `gocardless`, port `4871`,
protocol `http`, healthcheck `/health`, env `GOCARDLESS_ACCESS_TOKEN`,
`GOCARDLESS_VERSION`, `GOCARDLESS_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOCARDLESS_ACCESS_TOKEN=parlel
GOCARDLESS_VERSION=2015-07-06
GOCARDLESS_BASE_URL=http://localhost:4871
```

<!-- parlel:testenv:end -->
