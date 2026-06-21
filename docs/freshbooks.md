# FreshBooks

Lightweight, dependency-free, in-memory FreshBooks API fake for testing code that
uses the FreshBooks Accounting API.

Default port: `4872`

## Quick start

```js
import { FreshbooksServer } from "./services/freshbooks/src/server.js";

const server = new FreshbooksServer(4872);
await server.start();
// ... run your app/tests ...
await server.stop();
```

All API routes require an `Authorization: Bearer <token>` header (any non-empty
value accepted):

```js
const res = await fetch(
  "http://127.0.0.1:4872/accounting/account/parlelAcct/users/clients",
  {
    method: "POST",
    headers: { Authorization: "Bearer parlel", "Content-Type": "application/json" },
    body: JSON.stringify({ client: { fname: "Jane", email: "jane@parlel.dev" } }),
  }
);
```

## Access via MCP / preview URL

Reachable at its preview URL (`http://127.0.0.1:4872`) and through the parlel MCP
server as the `freshbooks` tool. Set `FRESHBOOKS_BASE_URL=http://127.0.0.1:4872`,
`FRESHBOOKS_ACCOUNT_ID`, and any non-empty `FRESHBOOKS_TOKEN`.

## Implemented operations

- `GET /auth/api/v1/users/me` — the authenticated identity + business memberships.
- `GET|POST /accounting/account/:accountId/users/clients` — list / create clients.
- `GET|PUT|DELETE /accounting/account/:accountId/users/clients/:id` — retrieve / update / archive.
- `GET|POST /accounting/account/:accountId/invoices/invoices` — list / create invoices.
- `GET /accounting/account/:accountId/invoices/invoices/:id` — retrieve an invoice.
- `GET /` / `GET /health` / `POST /__parlel/reset` — service + control endpoints.

## Response shapes

A single accounting resource is nested:

```json
{ "response": { "result": { "client": { "id": 1001, "email": "..." } } } }
```

A list adds pagination siblings:

```json
{ "response": { "result": { "clients": [ ... ], "page": 1, "pages": 1, "per_page": 15, "total": 1 } } }
```

Errors use `{ "response": { "errors": [{ "message", "errno" }] } }`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `users/me` identity | ✅ Supported |
| Clients CRUD | ✅ Supported |
| Invoices list / create / get | ✅ Supported |
| Bearer auth | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| OAuth token exchange / refresh | ⟳ Roadmap |
| Payments / expenses / time-tracking / projects | ⟳ Roadmap |
| `include[]` sub-resource expansion | ⟳ Roadmap — Not modelled |

## Manifest

See `services/freshbooks/manifest.json` — name `freshbooks`, port `4872`,
protocol `http`, healthcheck `/health`, env `FRESHBOOKS_TOKEN`,
`FRESHBOOKS_ACCOUNT_ID`, `FRESHBOOKS_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FRESHBOOKS_TOKEN=parlel
FRESHBOOKS_ACCOUNT_ID=parlelAcct
FRESHBOOKS_BASE_URL=http://localhost:4872
```

<!-- parlel:testenv:end -->
