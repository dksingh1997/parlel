# Coda

Lightweight, dependency-free, in-memory fake of the **Coda API v1** for testing code that talks to the Coda `/v1` REST surface.

Default port: `4796`

Auth is `Authorization: Bearer <token>`. Collections carry `{ items, href }`.

## Quick start

```js
import { CodaServer } from "./services/coda/src/server.js";

const server = new CodaServer(4796);
await server.start();
// ... run your app/tests ...
await server.stop();
```

```js
const res = await fetch(
  "http://127.0.0.1:4796/v1/docs/<docId>/tables/<tableId>/rows",
  {
    method: "POST",
    headers: { Authorization: "Bearer coda_xxx", "Content-Type": "application/json" },
    body: JSON.stringify({ rows: [{ cells: [{ column: "Name", value: "Task 1" }] }] }),
  }
);
// => 202 { requestId, addedRowIds: [...] }
```

## Access via MCP / preview URL

Point your MCP server / agent tooling at the preview URL printed by the parlel
pool (defaults to `http://127.0.0.1:4796`). Set `CODA_BASE_URL` to that URL and
supply any non-empty `CODA_API_TOKEN`; the fake accepts any `Bearer` token.

## Implemented operations

All `/v1/*` routes require an `Authorization: Bearer <token>` header.

### Docs
- `GET /v1/docs` — list docs (`{ items, href }`). A default doc always exists.
- `POST /v1/docs` — create a doc (`201`).
- `GET /v1/docs/:docId` — retrieve.

### Tables
- `GET /v1/docs/:docId/tables` — list tables (a default `Tasks` table exists).
- `GET /v1/docs/:docId/tables/:tableId` — retrieve a table.

### Rows
- `GET /v1/docs/:docId/tables/:tableId/rows` — list rows (`{ items, href }`).
- `POST /v1/docs/:docId/tables/:tableId/rows` — insert rows (`{ rows: [{ cells: [{ column, value }] }] }`). Returns `202 { requestId, addedRowIds }`.

### Account
- `GET /v1/whoami` — the authenticated principal.

### Service & inspection
- `GET /` — service metadata.
- `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Doc list / create / get | ✅ Supported |
| Table list / get | ✅ Supported |
| Row list / insert (`upsertRows`) | ✅ Supported |
| `{ items, href }` collection envelope | ✅ Supported |
| `202 Accepted` + `addedRowIds` on row insert | ✅ Supported |
| Columns, formulas, controls, pages, automations | ⟳ Roadmap |
| Row update / delete | ◐ Insert + list only |
| Async mutation status polling | ◐ Inserts are applied immediately |
| Table create | ◐ Default table only |
| Token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Error shapes

Errors use the Coda envelope `{ statusCode, statusMessage, message }`.

| Status | When |
| --- | --- |
| `401` | no `Authorization: Bearer` header |
| `404` | unknown doc / table / endpoint |
| `405` | method not allowed |

## Manifest

See `services/coda/manifest.json`:

- name: `coda`, image: `parlel/coda:1`
- port: `4796`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CODA_API_TOKEN`, `CODA_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CODA_API_TOKEN=coda_parlel
CODA_BASE_URL=http://localhost:4796
```

<!-- parlel:testenv:end -->
