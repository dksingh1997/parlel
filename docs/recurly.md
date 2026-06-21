# Recurly

Lightweight, dependency-free, in-memory Recurly **API v3** fake for testing code
that uses the Recurly subscription/billing API.

Default port: `4870`

## Quick start

```js
import { RecurlyServer } from "./services/recurly/src/server.js";

const server = new RecurlyServer(4870);
await server.start();
// ... run your app/tests ...
await server.stop();
```

the real Recurly v3 API:

```js
const basic = Buffer.from("parlel:").toString("base64");
const res = await fetch("http://127.0.0.1:4870/accounts", {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
  body: JSON.stringify({ code: "alice", email: "alice@parlel.dev" }),
});
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4870`) and through the parlel MCP
server as the `recurly` tool. Set `RECURLY_BASE_URL=http://127.0.0.1:4870` and any
non-empty `RECURLY_API_KEY`.

## Implemented operations

- `GET /accounts` / `POST /accounts` — list (`{ object: "list", has_more, data }`) / create.
- `GET /accounts/:id` — retrieve by id **or** `code-<code>`.
- `PUT|PATCH /accounts/:id` — update; `DELETE /accounts/:id` — deactivate.
- `GET|POST /accounts/:id/subscriptions` — list / create subscriptions.
- `GET /plans` / `POST /plans` / `GET /plans/:id` — manage plans (a `basic` plan is seeded).
- `POST /purchases` — create a one-off purchase → `{ object: "invoice_collection", charge_invoice }`.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

Resources carry an `object` discriminator (`"account"`, `"plan"`, `"subscription"`).

## Error envelope

```json
{ "error": { "type": "validation", "message": "..." } }
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Accounts CRUD | ✅ Supported |
| Plans list/create/get | ✅ Supported |
| Subscriptions list/create | ✅ Supported |
| Purchases | ✅ Supported |

| Invoices / line items / coupons / billing-info | ⟳ Roadmap |
| Real charging / dunning | ⟳ Roadmap — Purchases auto-`paid` |

## Manifest

See `services/recurly/manifest.json` — name `recurly`, port `4870`, protocol
`http`, healthcheck `/health`, env `RECURLY_API_KEY`, `RECURLY_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
RECURLY_API_KEY=parlel
RECURLY_BASE_URL=http://localhost:4870
```

<!-- parlel:testenv:end -->
