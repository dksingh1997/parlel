# Webflow

Lightweight, dependency-free, in-memory fake of the **Webflow Data API v2** for testing code that uses the real `webflow-api` SDK.

Default port: `4843`

## Quick start

```js
import { WebflowServer } from "./services/webflow/src/server.js";

const server = new WebflowServer(4843);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real client at it (override the base URL to `http://127.0.0.1:4843`) or drive the REST API directly:

```js
await fetch("http://127.0.0.1:4843/v2/collections/blog-posts/items", {
  method: "POST",
  headers: { Authorization: "Bearer parlel", "Content-Type": "application/json" },
  body: JSON.stringify({ fieldData: { name: "Hello", slug: "hello" } }),
});
```

## Access via MCP / preview URL

When run inside a parlel pool, reachable at its mapped preview URL (e.g.
`http://127.0.0.1:4843`). MCP clients drive sites, collections, and CMS items using
`WEBFLOW_API_TOKEN` and `WEBFLOW_SITE_ID`. Any non-empty Bearer token is accepted.

## Implemented operations

State is in-memory and ephemeral. All `/v2/*` routes require `Authorization: Bearer <token>`. A `parlel-site` site and `blog-posts` collection are seeded.

### Sites

- `GET /v2/sites` — list sites (`{ sites: [...] }`).
- `GET /v2/sites/:site_id` — fetch a site.

### Collections

- `GET /v2/collections/:collection_id` — fetch a collection (with `fields`).

### CMS items

- `GET /v2/collections/:collection_id/items` — list items. Supports `offset`/`limit`. Returns `{ items:[], pagination:{ limit, offset, total } }`.
- `POST /v2/collections/:collection_id/items` — create an item (`202`, `{ id, cmsLocaleId, fieldData, isDraft, isArchived, ... }`).
- `GET /v2/collections/:collection_id/items/:item_id` — fetch an item.
- `PATCH /v2/collections/:collection_id/items/:item_id` — update `fieldData`/`isDraft`/`isArchived`.
- `DELETE /v2/collections/:collection_id/items/:item_id` — delete an item (`204`).

### Service & inspection (parlel extensions)

- `GET /` — service metadata. `GET /health` — `{ status: "ok" }`.
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Sites list / get | ✅ Supported |
| Collection get (seeded `blog-posts`) | ✅ Supported |
| CMS item list (paginated) / create / get / patch / delete | ✅ Supported |
| Bearer token validity / scopes | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Item publishing (`/items/publish`), live vs staged | ⟳ Roadmap |
| Collection create/modify schema, custom fields validation | ⟳ Roadmap |
| Webhooks, forms, assets, ecommerce | ⟳ Roadmap |
| Real persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error shapes

Webflow v2 uses `{ message, code, externalReference, details }`:

| Status | When |
| --- | --- |
| `401` | missing/invalid Bearer token |
| `404` | unknown site/collection/item |

## Manifest

See `services/webflow/manifest.json` — name `webflow`, port `4843`, protocol `http`,
healthcheck `/health`, env `WEBFLOW_API_TOKEN`, `WEBFLOW_SITE_ID`, `WEBFLOW_BASE_URL`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WEBFLOW_API_TOKEN=parlel
WEBFLOW_SITE_ID=parlel-site
WEBFLOW_BASE_URL=http://localhost:4843
```

<!-- parlel:testenv:end -->
