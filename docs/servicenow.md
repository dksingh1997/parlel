# ServiceNow

Lightweight, dependency-free, in-memory fake of the ServiceNow Table API for testing code that talks to the ServiceNow REST Table API directly.

Default port: `4784`

## Quick start

```js
import { ServicenowServer } from "./services/servicenow/src/server.js";

const server = new ServicenowServer(4784);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const base = "http://127.0.0.1:4784";
const basic = Buffer.from("admin:pat-parlel").toString("base64");
const res = await fetch(`${base}/api/now/table/incident`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
  body: JSON.stringify({ short_description: "Email down", priority: "1" }),
});
// => { result: { sys_id, number: "INC0000001", short_description, ... } }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4784`, reachable through the parlel MCP/preview proxy under the slug `servicenow`.

## Implemented operations

All `/api/now/table/*` routes require `Authorization: Basic <...>` (or `Bearer`). State is in-memory and ephemeral.

Records are wrapped under `result` (single: `{ result: {...} }`; collection: `{ result: [...] }`). Each record gets a 32-char hex `sys_id`, a `number` (`INC…`, `PRB…`, `CHG…`, else `REC…`), and `sys_created_on` / `sys_updated_on`.

### Table API — `/api/now/table/:tableName`

- `POST /api/now/table/:tableName` — create a record.
- `GET /api/now/table/:tableName` — list (supports `sysparm_query=field=value^...`, `sysparm_limit`, `sysparm_offset`).
- `GET /api/now/table/:tableName/:sys_id` — retrieve.
- `PUT /api/now/table/:tableName/:sys_id` — replace/update.
- `PATCH /api/now/table/:tableName/:sys_id` — partial update.
- `DELETE /api/now/table/:tableName/:sys_id` — delete (`204`).

Any table name is accepted (`incident`, `problem`, `change_request`, custom tables, …).

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
| Table CRUD (any table) | ✅ Supported |
| `sys_id` (32-hex) + auto `number` | ✅ Supported |
| `sysparm_query` (`field=value^...`), `sysparm_limit/offset` | ✅ Supported |
| Basic + Bearer auth | ✅ Supported |
| Display-value vs raw-value (`sysparm_display_value`) | ◐ Raw values only |
| Reference field resolution / dot-walking | ⟳ Roadmap — Not resolved |
| ACLs / business rules / workflows | ⟳ Roadmap |
| Aggregate / Import Set / Attachment APIs | ⟳ Roadmap |
| Credential validity | ◐ Any well-formed Basic/Bearer accepted |

## Error codes & shapes

Errors use the ServiceNow envelope `{ error: { message, detail }, status: "failure" }`.

| Status | When |
| --- | --- |
| `400` | malformed JSON body |
| `401` | no Basic/Bearer auth |
| `404` | unknown `sys_id` / endpoint |
| `405` | method not allowed for the path |

## Manifest

See `services/servicenow/manifest.json`: name `servicenow`, port `4784`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`, `SERVICENOW_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SERVICENOW_USERNAME=admin
SERVICENOW_PASSWORD=pat-parlel
SERVICENOW_BASE_URL=http://localhost:4784
```

<!-- parlel:testenv:end -->
