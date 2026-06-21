# Pipedrive

Lightweight, dependency-free, in-memory fake of the Pipedrive API v1 for testing code that uses the `pipedrive` Node SDK (or the REST API directly).

Default port: `4779`

## Quick start

```js
import { PipedriveServer } from "./services/pipedrive/src/server.js";

const server = new PipedriveServer(4779);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point a client at it:

```js
const base = "http://127.0.0.1:4779";
const res = await fetch(`${base}/v1/persons?api_token=pat-parlel`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Ada Lovelace" }),
});
// => { success: true, data: { id, name, ... } }
```

## Access via MCP / preview URL

Plain HTTP at `http://127.0.0.1:4779`, reachable through the parlel MCP/preview proxy under the slug `pipedrive`.

## Implemented operations

Auth via `?api_token=<token>` query param **or** `Authorization: Bearer <token>` (any non-empty token works). State is in-memory and ephemeral.

Envelopes:
- single: `{ success: true, data: {...} }`
- list: `{ success: true, data: [...], additional_data: { pagination: {...} } }`

### Persons — `/v1/persons`

- `POST /v1/persons` — create (`name` required).
- `GET /v1/persons` — list (`?start=&limit=`).
- `GET /v1/persons/:id` — retrieve.
- `PUT /v1/persons/:id` — update.
- `DELETE /v1/persons/:id` — delete (returns `{ success, data: { id } }`).

### Deals — `/v1/deals`

Same CRUD surface (`title` required on create).

### Organizations — `/v1/organizations`

Same CRUD surface (`name` required on create).

### Leads — `/v1/leads`

Same CRUD surface (`title` required). Lead ids are UUID strings.

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
| Persons / Deals / Organizations / Leads CRUD | ✅ Supported |
| `api_token` query auth + Bearer auth | ✅ Supported |
| Pagination (`start`/`limit`, `additional_data.pagination`) | ✅ Supported |
| Required-field validation (name/title) | ✅ Supported |
| Activities / notes / files / pipelines / stages | ⟳ Roadmap |
| Search / filters endpoints | ⟳ Roadmap |
| Custom fields metadata | ◐ Stored verbatim, not validated |
| Token validity / company-domain scoping | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the Pipedrive envelope `{ success: false, error, error_info, data: null, additional_data: null }`.

| Status | When |
| --- | --- |
| `400` | missing required field / malformed JSON |
| `401` | no `api_token` and no `Authorization: Bearer` |
| `404` | unknown id / endpoint |
| `405` | method not allowed for the path |

## Manifest

See `services/pipedrive/manifest.json`: name `pipedrive`, port `4779`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PIPEDRIVE_API_TOKEN=pat-parlel
PIPEDRIVE_BASE_URL=http://localhost:4779
```

<!-- parlel:testenv:end -->
