# Groq

Lightweight, dependency-free, in-memory Groq API fake. Groq is OpenAI-compatible and mounts its API under `/openai/v1`, so the official `groq-sdk` (and the `openai` SDK pointed at Groq) work against this fake. All generated content is **deterministic** — derived from a hash of the input.

Default port: `4750`

## Quick start

```js
import { GroqServer } from "./services/groq/src/server.js";

const server = new GroqServer(4750);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `groq-sdk` at it via `baseURL`:

```js
import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: "gsk_parlel",
  baseURL: "http://127.0.0.1:4750/openai/v1",
});

const completion = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Hello Groq" }],
});
// completion.choices[0].message.content => deterministic text
```

## Implemented operations

All `/openai/v1/*` routes require an `Authorization: Bearer <key>` header (any non-empty bearer token is accepted). State is in-memory and ephemeral.

- `POST /openai/v1/chat/completions` — chat completion. Supports `stream: true` (SSE chunks ending with `data: [DONE]`, including the Groq-specific `x_groq` usage block). OpenAI-compatible shape.
- `GET /openai/v1/models` — list models (`owned_by: "Groq"`).
- `GET /openai/v1/models/{id}` — retrieve one model.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/requests` — list captured requests.
- `DELETE /__parlel/requests` — clear the captured request log.

## SDK usage example

```python
from openai import OpenAI

client = OpenAI(api_key="gsk_parlel", base_url="http://127.0.0.1:4750/openai/v1")
resp = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Hello Groq"}],
)
print(resp.choices[0].message.content)
```

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat.completions` (+ streaming SSE, `x_groq`) | ✅ Supported |
| `models` list/retrieve | ✅ Supported |
| Request inspection | ✅ Supported (parlel extension) |
| Real model inference / quality | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Audio transcription (`whisper`) | ⟳ Roadmap |
| `tools` / function calling | ◐ Accepted, not executed |
| Token counts | ◐ Approximate word-based |
| Bearer-token validity / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

## Manifest

See `services/groq/manifest.json`:

- name: `groq`, image: `parlel/groq:1`
- port: `4750`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `GROQ_API_KEY`, `GROQ_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GROQ_API_KEY=gsk_parlel
GROQ_BASE_URL=http://localhost:4750/openai/v1
```

<!-- parlel:testenv:end -->
