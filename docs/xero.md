# Xero

Lightweight, dependency-free, in-memory fake of the Xero Accounting API 2.0 for testing accounting integrations.

Default port: `4763`

## Quick start

```js
import { XeroServer } from "./services/xero/src/server.js";

const server = new XeroServer(4763);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Call the API with a Bearer token; responses are wrapped in the plural element name:

```js
const created = await fetch("http://127.0.0.1:4763/api.xro/2.0/Invoices", {
  method: "PUT",
  headers: {
    Authorization: "Bearer parlel-xero-token",
    "Xero-Tenant-Id": "parlel-tenant",
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({ Invoices: [{ Type: "ACCREC", Contact: { Name: "Jane Co" }, LineItems: [] }] }),
}).then((r) => r.json());
// created.Invoices[0].InvoiceID => a GUID
```

## Implemented operations

All `/api.xro/2.0/*` routes require an `Authorization: Bearer` header (any
non-empty token). Bodies and responses are wrapped in the plural element name
(`{ Invoices: [...] }`, `{ Contacts: [...] }`, `{ Accounts: [...] }`). GUID ids
are generated. State is in-memory and ephemeral.

### Invoices — `/api.xro/2.0/Invoices`

- `GET /Invoices` — list (`{ Invoices: [...] }`).
- `GET /Invoices/:id` — retrieve (returns a single-element `Invoices` array).
- `PUT /Invoices` — create new (`InvoiceID` GUID, `InvoiceNumber` default, `Status: "DRAFT"`).
- `POST /Invoices` — create or update (matching `InvoiceID` updates in place).

### Contacts — `/api.xro/2.0/Contacts`

- `GET` / `GET :id` / `PUT` / `POST` — same shape; `ContactID` GUID, `ContactStatus: "ACTIVE"`.

### Accounts — `/api.xro/2.0/Accounts`

- `GET` / `GET :id` / `PUT` / `POST` — same shape; `AccountID` GUID.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

Inside a parlel sandbox the service is reachable at its preview URL
(`XERO_BASE_URL`, e.g. `http://127.0.0.1:4763`). Pass `Authorization: Bearer`
and any `Xero-Tenant-Id`. MCP agents can call any documented endpoint;
`/__parlel/reset` clears state between scenarios.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `Invoices` list / get / create (PUT) / update (POST) | ✅ Supported |
| `Contacts` list / get / create / update | ✅ Supported |
| `Accounts` list / get / create / update | ✅ Supported |
| Plural-wrapped request/response | ✅ Supported |
| GUID ids, `/Date(...)/` timestamps | ✅ Supported |
| `where` / `order` filtering, pagination | ⟳ Roadmap — Returns all rows |
| Payments / BankTransactions / Reports / Items | ⟳ Roadmap |
| Attachments / history | ⟳ Roadmap |
| OAuth2 / connections endpoint | ✓ By design — Out of scope (token assumed valid) |
| Token validity / tenant scoping | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error codes & shapes

```json
{ "ErrorNumber": 10, "Type": "ValidationException", "Message": "..." }
```

| Status | When |
| --- | --- |
| `400` | malformed JSON body |
| `401` | missing Bearer token |
| `404` | unknown resource / id |
| `405` | method not allowed |

## Manifest

See `services/xero/manifest.json`:

- name: `xero`, image: `parlel/xero:1.0`
- port: `4763`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `XERO_ACCESS_TOKEN`, `XERO_TENANT_ID`, `XERO_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
XERO_ACCESS_TOKEN=parlel-xero-token
XERO_TENANT_ID=parlel-tenant
XERO_BASE_URL=http://localhost:4763
```

<!-- parlel:testenv:end -->
