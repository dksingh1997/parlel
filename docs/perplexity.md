# Perplexity

Lightweight, dependency-free, in-memory Perplexity API fake. The Perplexity chat API is OpenAI-compatible (`POST /chat/completions`) with an added Perplexity-specific `citations` array. All generated content is **deterministic** — text and citations are derived from a hash of the input.

Default port: `4751`

## Quick start

```js
import { PerplexityServer } from "./services/perplexity/src/server.js";

const server = new PerplexityServer(4751);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `openai` SDK at it via `baseURL`:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "pplx-parlel",
  baseURL: "http://127.0.0.1:4751",
});

const completion = await client.chat.completions.create({
  model: "sonar",
  messages: [{ role: "user", content: "What is parlel?" }],
});
// completion.choices[0].message.content => deterministic text
// completion.citations => deterministic list of source URLs
```

## Implemented operations

All routes require an `Authorization: Bearer <key>` header (any non-empty bearer token is accepted). State is in-memory and ephemeral.

- `POST /chat/completions` — chat completion. OpenAI-compatible shape plus a top-level `citations` array. Supports `stream: true` (SSE chunks carry `citations`, ending with `data: [DONE]`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata (includes available `models`).
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
from openai import OpenAI

client = OpenAI(api_key="pplx-parlel", base_url="http://127.0.0.1:4751")
resp = client.chat.completions.create(
    model="sonar",
    messages=[{"role": "user", "content": "What is parlel?"}],
)
print(resp.choices[0].message.content)
print(resp.citations)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat/completions` (+ streaming SSE) | ✅ Supported |
| `citations` array | ✅ Supported (deterministic) |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / web search | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| `search_domain_filter` / recency filters | ◐ Accepted, not applied |
| Token counts | ◐ Approximate word-based |
| Bearer-token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/perplexity/manifest.json`:

- name: `perplexity`, image: `parlel/perplexity:1`
- port: `4751`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `PERPLEXITY_API_KEY`, `PERPLEXITY_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
PERPLEXITY_API_KEY=pplx-parlel
PERPLEXITY_BASE_URL=http://localhost:4751
```

<!-- parlel:testenv:end -->
