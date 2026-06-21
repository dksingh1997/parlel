# Algolia

Lightweight, dependency-free, in-memory fake of the **Algolia Search & Indexing API** for testing search integrations. Implements a **real substring/token search** over indexed objects so queries return genuine matching hits. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4884`

## Quick start

```js
import { AlgoliaServer } from "./services/algolia/src/server.js";

const server = new AlgoliaServer(4884);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with the Algolia headers (any non-empty key + app id accepted):

```bash
curl -H "X-Algolia-API-Key: parlel" -H "X-Algolia-Application-Id: PARLELAPP" \
     -H "Content-Type: application/json" \
     -d '{"query":"shoes"}' \
     http://127.0.0.1:4884/1/indexes/products/query
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `ALGOLIA_APP_ID=parlel`, `ALGOLIA_API_KEY=parlel`, `ALGOLIA_BASE_URL=http://127.0.0.1:4884`, then index objects and run queries. The MCP server proxies the endpoints below so an agent can build and search an index without a real Algolia account.

## Implemented operations

All `/1/*` routes require `X-Algolia-API-Key` **and** `X-Algolia-Application-Id` headers (any non-empty values accepted; `403` otherwise).

- `POST /1/indexes/:indexName` — add an object (auto `objectID` if not supplied) → `201 { objectID, taskID, createdAt }`.
- `PUT /1/indexes/:indexName/:objectID` — add/replace an object with an explicit `objectID` → `200 { objectID, taskID, updatedAt }`. Validates that body `objectID` (if present) matches the URL.
- `GET /1/indexes/:indexName/:objectID` — retrieve an object → `200` (the record) or `404`.
- `DELETE /1/indexes/:indexName/:objectID` — delete an object → `200 { taskID, deletedAt }`.
- `DELETE /1/indexes/:indexName` — delete an entire index → `200 { taskID, deletedAt }`.
- `POST /1/indexes/:indexName/query` — **search** → `{ hits, nbHits, page, nbPages, hitsPerPage, query, params, processingTimeMS, exhaustiveNbHits }`. Real token search: a record matches when every query token is a substring of its flattened text (AND semantics). Empty query returns all records. Hits include a minimal `_highlightResult`.
- `POST /1/indexes/:indexName/batch` — batch operations → `{ taskID, objectIDs }`. Supported actions: `addObject`, `updateObject`, `partialUpdateObject`, `partialUpdateObjectNoCreate`, `deleteObject`, `delete` (delete index), `clear` (clear all records).

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
| Add / get / put / delete object | ✅ Supported |
| Delete index (`DELETE /1/indexes/:indexName`) | ✅ Supported |
| Batch operations (`addObject`, `updateObject`, `partialUpdateObject`, `partialUpdateObjectNoCreate`, `deleteObject`, `delete`, `clear`) | ✅ Supported |
| Real substring/token search with AND semantics + pagination | ✅ Supported |
| Search envelope (`hits, nbHits, page, nbPages, hitsPerPage, query, params, processingTimeMS, exhaustiveNbHits`) | ✅ Supported |
| `_highlightResult` on search hits | ✅ Supported |
| Error envelope (`{ message }`) matching Algolia format | ✅ Supported |
| Typo tolerance / synonyms / stemming / prefix ranking | ◐ Substring/token match only |
| Faceting / filters / numeric filters / geo search | ⟳ Roadmap |
| Custom ranking / searchable attributes config / settings | ⟳ Roadmap |
| `multipleQueries` / `browse` / `clear` endpoints | ⟳ Roadmap |

## Error codes & shapes

All error responses match the real Algolia error envelope: `{ message: string }`. No `status` field is included in the error body (matching the real API's `ErrorBase` schema).

| Status | When |
| --- | --- |
| `400` | Invalid JSON body, body/URL objectID mismatch |
| `403` | Missing or invalid `X-Algolia-API-Key` / `X-Algolia-Application-Id` |
| `404` | Unknown route, non-existent object, non-existent index |

## Manifest

See `services/algolia/manifest.json`:

- name: `algolia`, port: `4884`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `ALGOLIA_APP_ID`, `ALGOLIA_API_KEY`, `ALGOLIA_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ALGOLIA_APP_ID=parlel
ALGOLIA_API_KEY=parlel
ALGOLIA_BASE_URL=http://localhost:4884
```

<!-- parlel:testenv:end -->
