# Voyage AI

Lightweight, dependency-free, in-memory Voyage AI API fake for testing code that uses the real `voyageai` SDK (and REST API). Embeddings (1024-dim) and rerank scores are **deterministic** (hash-derived).

Default port: `4865`

## Quick start

```js
import { VoyageAiServer } from "./services/voyage-ai/src/server.js";

const server = new VoyageAiServer(4865);
await server.start();
// ... run your app/tests ...
await server.stop();
```

REST usage:

```js
const res = await fetch("http://127.0.0.1:4865/v1/embeddings", {
  method: "POST",
  headers: { Authorization: "Bearer pa-parlel-voyage", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "voyage-3", input: ["hello", "world"] }),
});
// => { object: "list", data: [{ object: "embedding", embedding: [...1024], index }], model, usage: { total_tokens } }
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4865/v1`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth: `Authorization: Bearer <key>` (any non-empty token).

## Implemented operations

- `POST /v1/embeddings` — `{ model, input }` → `{ object: "list", data: [{ object: "embedding", embedding: [...1024], index }], model, usage: { total_tokens } }`. `output_dimension` is respected.
- `POST /v1/rerank` — `{ model, query, documents, top_k?, return_documents? }` → `{ object: "list", data: [{ relevance_score, index, document? }], model, usage }`. Results are ranked by descending `relevance_score`.

### Service & inspection operations (parlel extensions)

- `GET /` / `GET /health` / `POST /__parlel/reset` / `GET /__parlel/requests`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `embeddings` (1024-dim, deterministic) | ✅ Supported |
| `rerank` (deterministic ranked scores) | ✅ Supported |
| `output_dimension`, `top_k`, `return_documents` | ✅ Supported |
| Real semantic embeddings / reranking | ✓ By design — Intentionally unsupported (hash-derived) |
| Contextualized / multimodal embeddings | ⟳ Roadmap |
| `input_type` semantic differences | ◐ Accepted, no behavioral effect |
| Key validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Error codes & shapes

Errors use `{ "detail": "..." }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` |
| `400` | missing `model`/`input`/`query`/`documents` or bad JSON |
| `404` | unknown endpoint |

## Manifest

See `services/voyage-ai/manifest.json`:

- name: `voyage-ai`, port: `4865`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `VOYAGE_API_KEY`, `VOYAGE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
VOYAGE_API_KEY=pa-parlel-voyage
VOYAGE_BASE_URL=http://localhost:4865/v1
```

<!-- parlel:testenv:end -->
