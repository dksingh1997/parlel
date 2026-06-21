# QuickBooks Online

Lightweight, dependency-free, in-memory fake of the QuickBooks Online Accounting v3 API for testing accounting integrations.

Default port: `4762`

## Quick start

```js
import { QuickbooksServer } from "./services/quickbooks/src/server.js";

const server = new QuickbooksServer(4762);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Call the API with a Bearer token and your realm id:

```js
const realm = "parlel-realm";
const customer = await fetch(`http://127.0.0.1:4762/v3/company/${realm}/customer`, {
  method: "POST",
  headers: { Authorization: "Bearer parlel-qbo-token", "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ DisplayName: "Jane Co" }),
}).then((r) => r.json());
// customer.Customer.Id => "1"
```

## Implemented operations

All `/v3/company/:realmId/*` routes require an `Authorization: Bearer` header
(any non-empty token). Entities are wrapped (e.g. `{ Customer: {...} }`). State
is in-memory and ephemeral.

### Customer — `/v3/company/:realmId/customer`

- `POST /v3/company/:realmId/customer` — create (returns `{ Customer: {...} }`, `Id`, `SyncToken: "0"`). Passing an existing `Id` performs a sparse update (`SyncToken` increments).
- `GET /v3/company/:realmId/customer/:id` — retrieve.

### Invoice — `/v3/company/:realmId/invoice`

- `POST /v3/company/:realmId/invoice` — create (`DocNumber` defaults to `INV-:id`).
- `GET /v3/company/:realmId/invoice/:id` — retrieve.

### Query — `/v3/company/:realmId/query`

- `GET /v3/company/:realmId/query?query=select * from Customer` — returns `{ QueryResponse: { Customer: [...], maxResults } }`.
- `POST /v3/company/:realmId/query` — raw SQL-ish body (`Content-Type: application/text`) for the same query surface.

Supported entities for query/CRUD: `Customer`, `Invoice`, `Item`, `Payment`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`QUICKBOOKS_BASE_URL`, e.g. `http://127.0.0.1:4762`). Use any
`QUICKBOOKS_REALM_ID` in the path and pass `Authorization: Bearer`. MCP agents
can call any documented endpoint; `/__parlel/reset` clears state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `Customer` create / get / sparse-update | ✅ Supported |
| `Invoice` create / get | ✅ Supported |
| `query` (GET ?query / POST raw) | ✅ Supported |
| Entity wrapping + `SyncToken` / `MetaData` | ✅ Supported |
| `Item` / `Payment` query | ✅ Supported (created via generic POST) |
| Full SQL grammar (WHERE / ORDER BY / paging) | ◐ Parses `FROM <entity>`; returns all rows |
| Batch operations / CDC / reports | ⟳ Roadmap |
| OAuth2 token refresh | ✓ By design — Out of scope (token assumed valid) |
| Webhooks | ✓ By design — Not emitted |
| Token validity / minor-version handling | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

Errors use the QBO `Fault` envelope:

```json
{ "Fault": { "Error": [{ "Message": "...", "code": "610", "Detail": "..." }], "type": "ValidationFault" }, "time": "..." }
```

| Status | When |
| --- | --- |
| `401` | missing Bearer token |
| `404` | unknown entity id (`Object Not Found`) or unsupported resource |

## Manifest

See `services/quickbooks/manifest.json`:

- name: `quickbooks`, image: `parlel/quickbooks:1.0`
- port: `4762`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `QUICKBOOKS_ACCESS_TOKEN`, `QUICKBOOKS_REALM_ID`, `QUICKBOOKS_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
QUICKBOOKS_ACCESS_TOKEN=parlel-qbo-token
QUICKBOOKS_REALM_ID=parlel-realm
QUICKBOOKS_BASE_URL=http://localhost:4762
```

<!-- parlel:testenv:end -->
