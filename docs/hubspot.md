# HubSpot

Lightweight, dependency-free, in-memory fake of the HubSpot CRM API v3 for testing code that uses the real `@hubspot/api-client` SDK (or the language-agnostic HubSpot REST API).

Default port: `4777`

## Quick start

```js
import { HubspotServer } from "./services/hubspot/src/server.js";

const server = new HubspotServer(4777);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real client at it:

```js
import { Client } from "@hubspot/api-client";

const hubspot = new Client({
  accessToken: "pat-parlel",
  basePath: "http://127.0.0.1:4777",
});

const created = await hubspot.crm.contacts.basicApi.create({
  properties: { email: "a@parlel.dev", firstname: "Ada" },
});
// created.id, created.properties, created.createdAt, ...
```

## Access via MCP / preview URL

The fake is plain HTTP on `http://127.0.0.1:4777`. In the parlel pool it is reachable through the standard MCP/preview proxy at the slug `hubspot`. All routes below are relative to the base URL.

## Implemented operations

All `/crm/*` routes require an `Authorization: Bearer <token>` header (any non-empty bearer token works). State is in-memory and ephemeral.

Object shape: `{ id, properties: {}, createdAt, updatedAt, archived }`.
List shape: `{ results: [...], paging: { next: { after } } }`.

### Contacts — `/crm/v3/objects/contacts`

- `POST /crm/v3/objects/contacts` — create (`201`), body `{ properties: {} }`. Returns `409 CONFLICT` if a contact with the same `email` already exists (companies dedupe on `domain`).
- `GET /crm/v3/objects/contacts` — list (`?limit=&after=`).
- `GET /crm/v3/objects/contacts/:id` — retrieve.
- `PATCH /crm/v3/objects/contacts/:id` — merge-update properties.
- `DELETE /crm/v3/objects/contacts/:id` — archive/remove (`204`).
- `POST /crm/v3/objects/contacts/search` — filter via `filterGroups` (`EQ`, `NEQ`, `HAS_PROPERTY`, `CONTAINS_TOKEN`).
- `POST /crm/v3/objects/contacts/batch/create` — batch create, body `{ inputs: [{ properties: {} }] }` → `201` `{ status: "COMPLETE", results: [...], startedAt, completedAt }`.
- `POST /crm/v3/objects/contacts/batch/read` — batch read, body `{ inputs: [{ id }] }` → `200` `{ status: "COMPLETE", results: [...] }`.
- `POST /crm/v3/objects/contacts/batch/update` — batch update, body `{ inputs: [{ id, properties: {} }] }` → `200` `{ status: "COMPLETE", results: [...] }`.
- `POST /crm/v3/objects/contacts/batch/archive` — batch archive, body `{ inputs: [{ id }] }` → `204`.

### Companies — `/crm/v3/objects/companies`

Same CRUD + search surface as contacts.

### Deals — `/crm/v3/objects/deals`

Same CRUD + search surface as contacts.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Contacts / Companies / Deals CRUD | ✅ Supported |
| Batch create / read / update / archive | ✅ Supported |
| Search (`filterGroups`, common operators) | ✅ Supported |
| Pagination (`limit`/`after`) | ✅ Supported |
| Object shape `{id,properties,createdAt,updatedAt,archived}` | ✅ Supported |
| Duplicate-create `409 CONFLICT` (contact `email`, company `domain`) | ✅ Supported |
| `?properties=` / `?associations=` projection on read | ◐ Accepted — full property set returned |
| `?archived=` filter on list | ◐ Accepted — emulator never archives |
| Full search operator set (BETWEEN, IN, GT/LT, sorts) | ◐ Common subset only |
| Associations / properties / schema APIs | ⟳ Roadmap |
| Tickets / line items / custom objects | ⟳ Roadmap |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Rate limiting (`429`) | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the HubSpot envelope `{ status:"error", message, correlationId, category }`.

| Status | `category` | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | missing `properties` / missing batch `inputs` / malformed JSON |
| `401` | `INVALID_AUTHENTICATION` | no `Authorization: Bearer` header |
| `404` | `OBJECT_NOT_FOUND` | unknown id / object type / endpoint |
| `405` | `METHOD_NOT_ALLOWED` | method not allowed for the path |
| `409` | `CONFLICT` | create with a duplicate unique identifier (contact `email`, company `domain`) |

## Manifest

See `services/hubspot/manifest.json`: name `hubspot`, port `4777`, protocol `http`, healthcheck `/health`, startup ≈ 100ms, env `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
HUBSPOT_ACCESS_TOKEN=pat-parlel
HUBSPOT_BASE_URL=http://localhost:4777
```

<!-- parlel:testenv:end -->
