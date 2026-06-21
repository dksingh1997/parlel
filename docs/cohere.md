# Cohere

Lightweight, dependency-free, in-memory Cohere v2 API fake for testing code that uses the real `cohere-ai` SDK (and the language-agnostic v2 REST API). All generated content is **deterministic** — text, embedding vectors, and rerank scores are derived from a hash of the input.

Default port: `4754`

## Quick start

```js
import { CohereServer } from "./services/cohere/src/server.js";

const server = new CohereServer(4754);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `cohere-ai` client at it via `environment`:

```js
import { CohereClientV2 } from "cohere-ai";

const cohere = new CohereClientV2({
  token: "parlel",
  environment: "http://127.0.0.1:4754",
});

const response = await cohere.chat({
  model: "command-r-plus",
  messages: [{ role: "user", content: "Hello Cohere" }],
});
// response.message.content[0].text => deterministic text
```

## Implemented operations

All `/v2/*` routes require an `Authorization: Bearer <key>` header (any non-empty bearer token is accepted). State is in-memory and ephemeral.

- `POST /v2/chat` — chat. Returns `{ id, message: { role, content: [{ type: "text", text }] }, finish_reason, usage }`. Supports `stream: true` via the Cohere v2 SSE event types (`message-start`, `content-start`, `content-delta`, `content-end`, `message-end`), ending with `data: [DONE]`.
- `POST /v2/embed` — embeddings. Returns `{ id, embeddings: { float: [...] }, texts, meta }` (deterministic 1024-dim vectors). Requires `texts`, `model`, `input_type`.
- `POST /v2/rerank` — rerank documents against a query. Returns `{ id, results: [{ index, relevance_score }], meta }`, sorted descending, honoring `top_n`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
import cohere

co = cohere.ClientV2(api_key="parlel", base_url="http://127.0.0.1:4754")
res = co.rerank(
    model="rerank-english-v3.0",
    query="What is parlel?",
    documents=["parlel is a tool", "unrelated", "another parlel mention"],
    top_n=2,
)
for r in res.results:
    print(r.index, r.relevance_score)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `v2/chat` (+ streaming SSE) | ✅ Supported |
| `v2/embed` (deterministic float vectors) | ✅ Supported |
| `v2/rerank` (sorted scores, `top_n`) | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| `tools` / connectors / web search | ◐ Accepted, not executed |
| `int8` / `binary` embedding types | ◐ Only `float` returned |
| Token / billing counts | ◐ Approximate word-based |
| Bearer-token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/cohere/manifest.json`:

- name: `cohere`, image: `parlel/cohere:1`
- port: `4754`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `COHERE_API_KEY`, `CO_API_KEY`, `COHERE_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
COHERE_API_KEY=parlel
CO_API_KEY=parlel
COHERE_BASE_URL=http://localhost:4754
```

<!-- parlel:testenv:end -->
