# OpenRouter

Lightweight, dependency-free, in-memory OpenRouter API fake. OpenRouter is OpenAI-compatible, so this works with the official `openai` SDK pointed at it. All output is **deterministic** (hash-derived) and SSE streaming is supported.

Default port: `4861`

## Quick start

```js
import { OpenrouterServer } from "./services/openrouter/src/server.js";

const server = new OpenrouterServer(4861);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `openai` SDK at it:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-or-parlel",
  baseURL: "http://127.0.0.1:4861/api/v1",
});

const res = await client.chat.completions.create({
  model: "anthropic/claude-3.5-sonnet",
  messages: [{ role: "user", content: "hello" }],
});
// res.choices[0].message.content => deterministic text; res.provider => routing field
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4861/api/v1`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth: `Authorization: Bearer <key>` (any non-empty token). `GET /api/v1/models` is public.

## Implemented operations

- `POST /api/v1/chat/completions` — OpenAI-compatible chat. Supports `stream: true` (SSE, terminated by `data: [DONE]`). Adds an OpenRouter `provider` routing field.
- `POST /api/v1/embeddings` — OpenAI-compatible embeddings (deterministic).
- `GET /api/v1/models` — public model catalog (vendor-prefixed ids like `openai/gpt-4o`).

### Service & inspection operations (parlel extensions)

- `GET /` / `GET /health` / `POST /__parlel/reset` / `GET /__parlel/requests`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat.completions` (non-stream + SSE stream) | ✅ Supported |
| `embeddings` | ✅ Supported |
| `models` list with routing/provider field | ✅ Supported |
| Deterministic, reproducible output | ✅ Supported |
| Real model inference | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Provider preferences / fallbacks / transforms | ◐ `provider` echoed from model prefix only |
| Credits / cost accounting | ✓ By design — Not enforced |
| Tool/function calling, vision | ◐ Accepted, not specially handled |

## Error codes & shapes

Errors use the OpenAI envelope: `{ "error": { "message", "type", "code" } }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` (except `/models`) |
| `400` | missing `model`/`messages`/`input` or bad JSON |
| `404` | unknown endpoint |

## Manifest

See `services/openrouter/manifest.json`:

- name: `openrouter`, port: `4861`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
OPENROUTER_API_KEY=sk-or-parlel
OPENROUTER_BASE_URL=http://localhost:4861/api/v1
```

<!-- parlel:testenv:end -->
