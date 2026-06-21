# Freshsales

Lightweight, dependency-free, in-memory fake of the Freshsales (Freshworks CRM) API for testing code that talks to the Freshsales REST API directly.

Default port: `4783`

## Quick start

```js
import { FreshsalesServer } from "./services/freshsales/src/server.js";

const server = new FreshsalesServer(4783);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it (auth via the `Token token=` header scheme):

```js
const base = "http://127.0.0.1:4783";
const res = await fetch(`${base}/api/contacts`, {
  method: "POST",
  headers: { Authorization: "Token token=pat-parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@parlel.dev" } }),
});
// => { contact: { id, first_name, ... } }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4783`, reachable through the parlel MCP/preview proxy under the slug `freshsales`.

## Implemented operations

All `/api/*` routes require `Authorization: Token token=<api-key>` (or `Bearer`). State is in-memory and ephemeral.

Single resources are wrapped under the singular key (`{ contact: {...} }`); collections under the plural key with `meta` (`{ contacts: [...], meta: { total_pages, total } }`).

### Contacts — `/api/contacts`

- `POST /api/contacts` — create (one of `first_name`/`last_name`/`email` required).
- `GET /api/contacts` — list.
- `GET /api/contacts/:id` — retrieve.
- `PUT /api/contacts/:id` — update.
- `DELETE /api/contacts/:id` — delete.

### Leads — `/api/leads`

CRUD surface (same name/email requirement).

### Deals — `/api/deals`

CRUD surface (`name` required on create).

### Sales accounts — `/api/sales_accounts`

CRUD surface (`name` required on create).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Contacts / Leads / Deals / Sales accounts CRUD | ✅ Supported |
| `Token token=` header auth + Bearer | ✅ Supported |
| Wrapped single + collection envelopes (+ `meta`) | ✅ Supported |
| Required-field validation (`400` with `errors`) | ✅ Supported |
| Filtered/view-based listing, lookups, search | ⟳ Roadmap |
| Sales activities / appointments / tasks / notes | ⟳ Roadmap |
| Pagination beyond a single page | ◐ `total_pages: 1` |
| API-key validity | ◐ Any well-formed token accepted |

## Error codes & shapes

Errors use the Freshsales envelope `{ errors: { message: [...], <field>: [...] } }`.

| Status | When |
| --- | --- |
| `400` | malformed JSON / validation failure |
| `401` | no `Token token=` / Bearer auth |
| `404` | unknown id / resource |
| `405` | method not allowed for the path |

## Manifest

See `services/freshsales/manifest.json`: name `freshsales`, port `4783`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `FRESHSALES_API_KEY`, `FRESHSALES_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FRESHSALES_API_KEY=pat-parlel
FRESHSALES_BASE_URL=http://localhost:4783
```

<!-- parlel:testenv:end -->
