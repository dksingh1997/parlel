# DeepSeek

Lightweight, dependency-free, in-memory DeepSeek API fake. DeepSeek is OpenAI-compatible (`POST /chat/completions`, `GET /models`), so the `openai` SDK works against this fake. All generated content is **deterministic** — derived from a hash of the input. `deepseek-reasoner` additionally returns a `reasoning_content` field.

Default port: `4752`

## Quick start

```js
import { DeepseekServer } from "./services/deepseek/src/server.js";

const server = new DeepseekServer(4752);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `openai` SDK at it via `baseURL`:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-parlel",
  baseURL: "http://127.0.0.1:4752",
});

const completion = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "Hello DeepSeek" }],
});
// completion.choices[0].message.content => deterministic text
```

## Implemented operations

All routes require an `Authorization: Bearer <key>` header (any non-empty bearer token is accepted). Both bare paths and an optional `/v1` prefix are accepted. State is in-memory and ephemeral.

- `POST /chat/completions` — chat completion. Supports `stream: true` (SSE ending with `data: [DONE]`). `deepseek-reasoner` returns a `reasoning_content` field and prompt-cache usage counters.
- `GET /models` — list models (`deepseek-chat`, `deepseek-reasoner`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
from openai import OpenAI

client = OpenAI(api_key="sk-parlel", base_url="http://127.0.0.1:4752")
resp = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Solve this"}],
)
print(resp.choices[0].message.reasoning_content)
print(resp.choices[0].message.content)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat/completions` (+ streaming SSE) | ✅ Supported |
| `reasoning_content` (`deepseek-reasoner`) | ✅ Supported |
| `models` list | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| `tools` / function calling | ◐ Accepted, not executed |
| Prompt-cache accounting | ◐ Static counters, not real caching |
| Token counts | ◐ Approximate word-based |
| Bearer-token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/deepseek/manifest.json`:

- name: `deepseek`, image: `parlel/deepseek:1`
- port: `4752`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DEEPSEEK_API_KEY=sk-parlel
DEEPSEEK_BASE_URL=http://localhost:4752
```

<!-- parlel:testenv:end -->
