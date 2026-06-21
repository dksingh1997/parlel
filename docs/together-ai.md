# Together AI

Lightweight, dependency-free, in-memory Together AI API fake. Together AI is OpenAI-compatible, so this works with the official `together-ai` / `openai` SDKs. All output is **deterministic** (hash-derived) and SSE streaming is supported.

Default port: `4863`

## Quick start

```js
import { TogetherAiServer } from "./services/together-ai/src/server.js";

const server = new TogetherAiServer(4863);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `openai` SDK at it:

```js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: "parlel-together", baseURL: "http://127.0.0.1:4863/v1" });
const res = await client.chat.completions.create({
  model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  messages: [{ role: "user", content: "hello" }],
});
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4863/v1`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth: `Authorization: Bearer <key>` (any non-empty token).

## Implemented operations

- `POST /v1/chat/completions` — OpenAI-compatible chat. Supports `stream: true` (SSE, `data: [DONE]`).
- `POST /v1/completions` — legacy text completion.
- `POST /v1/embeddings` — deterministic 768-dim embeddings.
- `POST /v1/images/generations` — deterministic base64 PNG images.
- `GET /v1/models` — model catalog (vendor-prefixed ids).

### Service & inspection operations (parlel extensions)

- `GET /` / `GET /health` / `POST /__parlel/reset` / `GET /__parlel/requests`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `chat.completions` (non-stream + SSE) | ✅ Supported |
| `completions` (legacy) | ✅ Supported |
| `embeddings` | ✅ Supported |
| `images/generations` | ✅ Supported |
| `models` list | ✅ Supported |
| Deterministic, reproducible output | ✅ Supported |
| Real model inference | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Fine-tuning / files / batch jobs | ⟳ Roadmap |
| Tool/function calling, JSON mode | ◐ Accepted, not specially handled |

## Error codes & shapes

Errors use the OpenAI envelope: `{ "error": { "message", "type", "code" } }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` |
| `400` | missing `model`/`messages`/`prompt`/`input` or bad JSON |
| `404` | unknown endpoint |

## Manifest

See `services/together-ai/manifest.json`:

- name: `together-ai`, port: `4863`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `TOGETHER_API_KEY`, `TOGETHER_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TOGETHER_API_KEY=parlel-together
TOGETHER_BASE_URL=http://localhost:4863/v1
```

<!-- parlel:testenv:end -->
