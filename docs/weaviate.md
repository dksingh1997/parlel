# Weaviate

Lightweight, dependency-free, in-memory Weaviate REST + GraphQL fake for testing code that uses the real `weaviate-client` / `weaviate-ts-client` SDK. Stores vectors in memory and performs a **real cosine nearest-neighbor search**.

Default port: `4859`

## Quick start

```js
import { WeaviateServer } from "./services/weaviate/src/server.js";

const server = new WeaviateServer(4859);
await server.start();
// ... run your app/tests ...
await server.stop();
```

REST usage:

```js
// Create a class
await fetch("http://127.0.0.1:4859/v1/schema", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ class: "Article", vectorizer: "none" }),
});

// Add an object with a vector
await fetch("http://127.0.0.1:4859/v1/objects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ class: "Article", properties: { title: "hi" }, vector: [1, 0, 0] }),
});

// nearVector search via GraphQL
await fetch("http://127.0.0.1:4859/v1/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    query: `{ Get { Article(nearVector: { vector: [0.9, 0.1, 0] }, limit: 3) { title _additional { id distance certainty } } } }`,
  }),
});
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4859`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth: optional. Anonymous access is enabled by default; any `Bearer` token is accepted.

## Implemented operations

- `POST /v1/schema` — create a class. `GET /v1/schema` — list. `GET /v1/schema/:className` — retrieve. `DELETE /v1/schema/:className` — drop (also removes its objects).
- `POST /v1/objects` — create an object `{ class, id?, properties, vector }`. `GET /v1/objects` — list.
- `GET /v1/objects/:className/:id` — retrieve. `PUT` — update. `DELETE` — remove.
- `POST /v1/graphql` — `Get { Class(nearVector: { vector: [...] }, limit: N) { ...props _additional { id distance certainty } } }`. Performs a real cosine-similarity NN search over stored vectors. `distance = 1 - cosine_similarity`, `certainty = (cosine + 1) / 2`; results sorted ascending by distance.
- `GET /v1/meta` — cluster metadata.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata. `GET /health` — health check.
- `POST /__parlel/reset` — reset state. `GET /__parlel/objects` — list stored objects.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Schema CRUD (`class` create/list/get/delete) | ✅ Supported |
| Object CRUD with explicit vectors | ✅ Supported |
| GraphQL `Get` + `nearVector` cosine NN search | ✅ Supported (real cosine) |
| `_additional { id distance certainty }` | ✅ Supported |
| Module-based vectorization (text2vec) | ⟳ Roadmap — supply explicit vectors |
| `nearVector` similarity search (cosine) | ✅ Supported |
| `bm25` keyword search (term-frequency ranking, `properties` scope, `_additional { score }`) | ✅ Supported |
| `where` filters (`Equal`/`NotEqual`/`GreaterThan(Equal)`/`LessThan(Equal)`/`Like`, `And`/`Or` operands) | ✅ Supported |
| `nearText` / `nearObject` / hybrid | ✓ By design — require a vectorizer module; supply explicit vectors with `nearVector` instead |
| Aggregation (`Aggregate {}`) | ⟳ Roadmap |
| Cross-references / multi-tenancy | ⟳ Roadmap |
| Auth / RBAC | ◐ Anonymous; any bearer accepted |

## Error codes & shapes

REST errors use `{ "error": [{ "message": "..." }] }`. GraphQL errors use `{ "data": null, "errors": [{ "message": "..." }] }`.

| Status | When |
| --- | --- |
| `422` | missing `class` name |
| `404` | unknown class / object / endpoint |
| `400` | invalid JSON body |

## Manifest

See `services/weaviate/manifest.json`:

- name: `weaviate`, image: `parlel/weaviate:1.0`
- port: `4859`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `WEAVIATE_API_KEY`, `WEAVIATE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
WEAVIATE_API_KEY=parlel_weaviate
WEAVIATE_BASE_URL=http://localhost:4859
```

<!-- parlel:testenv:end -->
