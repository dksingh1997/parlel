# Chroma

Lightweight, dependency-free, in-memory Chroma (v1) API fake for testing code that uses the real `chromadb` client. Stores embeddings in memory and performs a **real L2 nearest-neighbor query**.

Default port: `4860`

## Quick start

```js
import { ChromaServer } from "./services/chroma/src/server.js";

const server = new ChromaServer(4860);
await server.start();
// ... run your app/tests ...
await server.stop();
```

REST usage:

```js
// Create a collection
const col = await (await fetch("http://127.0.0.1:4860/api/v1/collections", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "docs" }),
})).json();

// Add embeddings
await fetch(`http://127.0.0.1:4860/api/v1/collections/${col.id}/add`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids: ["a"], embeddings: [[1, 0, 0]], documents: ["doc a"] }),
});

// Query nearest neighbors
const res = await fetch(`http://127.0.0.1:4860/api/v1/collections/${col.id}/query`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query_embeddings: [[0.9, 0.1, 0]], n_results: 3 }),
});
// => { ids, distances, documents, metadatas }
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4860`
- Health: `GET /health` → `{ "status": "ok" }`
- Heartbeat: `GET /api/v1/heartbeat` → `{ "nanosecond heartbeat": N }`
- No auth required (matches the default Chroma server).

## Implemented operations

- `POST /api/v1/collections` — create (`{ name, metadata?, get_or_create? }`). `GET` — list.
- `GET /api/v1/collections/:name` — retrieve. `DELETE /api/v1/collections/:name` — drop.
- `POST /api/v1/collections/:id/add` — add `{ ids, embeddings, documents?, metadatas? }`. `upsert` aliased.
- `POST /api/v1/collections/:id/query` — nearest-neighbor by `{ query_embeddings, n_results }` → `{ ids, distances, documents, metadatas }` (squared L2, ascending). Multiple query vectors supported.
- `POST /api/v1/collections/:id/get` — fetch records (optionally by `ids`).
- `GET /api/v1/collections/:id/count` — record count.
- `POST /api/v1/collections/:id/delete` — delete records by `ids`.
- `GET /api/v1/heartbeat`, `GET /api/v1/version`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata. `GET /health` — health check.
- `POST /__parlel/reset` — reset state. `GET /__parlel/collections` — list collections + counts.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Collection create/list/get/delete | ✅ Supported |
| `add` / `upsert` with explicit embeddings | ✅ Supported |
| `query` nearest-neighbor (L2) | ✅ Supported (real squared L2) |
| `get` / `count` / `delete` records | ✅ Supported |
| Server-side embedding functions | ⟳ Roadmap — supply embeddings |
| `where` metadata filters (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin`/`$and`/`$or`) | ✅ Supported |
| `where_document` filters (`$contains` / `$not_contains` / `$and` / `$or`) | ✅ Supported |
| `limit` / `offset` on `get` | ✅ Supported |
| Cosine/IP space selection | ◐ Default squared-L2 ordering (metadata accepted) |
| Auth tokens | ◐ Not required |

## Error codes & shapes

Errors use `{ "error": "..." }`.

| Status | When |
| --- | --- |
| `400` | missing `name` / `embeddings` / `query_embeddings` |
| `404` | unknown collection or endpoint |
| `409` | collection already exists (without `get_or_create`) |

## Manifest

See `services/chroma/manifest.json`:

- name: `chroma`, image: `parlel/chroma:1.0`
- port: `4860`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `CHROMA_BASE_URL`, `CHROMA_SERVER_HOST`, `CHROMA_SERVER_HTTP_PORT`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CHROMA_BASE_URL=http://localhost:4860
CHROMA_SERVER_HOST=localhost:4860
CHROMA_SERVER_HTTP_PORT=4860
```

<!-- parlel:testenv:end -->
