# Mistral

Lightweight, dependency-free, in-memory Mistral AI API fake. Mistral is OpenAI-compatible under `/v1`, so both the official `@mistralai/mistralai` SDK and the `openai` SDK work against this fake. All generated content is **deterministic** — text and embedding vectors are derived from a hash of the input.

Default port: `4755`

## Quick start

```js
import { MistralServer } from "./services/mistral/src/server.js";

const server = new MistralServer(4755);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `openai` SDK at it via `baseURL` (or set the Mistral SDK's `serverURL`):

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "parlel",
  baseURL: "http://127.0.0.1:4755/v1",
});

const completion = await client.chat.completions.create({
  model: "mistral-large-latest",
  messages: [{ role: "user", content: "Hello Mistral" }],
});
```

## Implemented operations

All `/v1/*` routes require an `Authorization: Bearer <key>` header (any non-empty bearer token is accepted). State is in-memory and ephemeral.

- `POST /v1/chat/completions` — chat completion. Supports `stream: true` (SSE ending with `data: [DONE]`).
- `POST /v1/embeddings` — deterministic 1024-dim embedding vectors. Accepts a string or array of strings.
- `GET /v1/models` — list models.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
from mistralai import Mistral

client = Mistral(api_key="parlel", server_url="http://127.0.0.1:4755")
resp = client.chat.complete(
    model="mistral-large-latest",
    messages=[{"role": "user", "content": "Hello Mistral"}],
)
print(resp.choices[0].message.content)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat/completions` (+ streaming SSE) | ✅ Supported |
| `embeddings` (deterministic 1024-dim) | ✅ Supported |
| `models` list | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| `tools` / function calling | ◐ Accepted, not executed (`tool_calls: null`) |
| FIM / agents / fine-tuning endpoints | ⟳ Roadmap |
| Token counts | ◐ Approximate word-based |
| Bearer-token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/mistral/manifest.json`:

- name: `mistral`, image: `parlel/mistral:1`
- port: `4755`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `MISTRAL_API_KEY`, `MISTRAL_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MISTRAL_API_KEY=parlel
MISTRAL_BASE_URL=http://localhost:4755/v1
```

<!-- parlel:testenv:end -->
