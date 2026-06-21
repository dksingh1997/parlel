# Fireworks AI

Lightweight, dependency-free, in-memory Fireworks AI API fake. Fireworks AI is OpenAI-compatible and serves under `/inference/v1`. Works with the official `openai` SDK pointed at it. All output is **deterministic** (hash-derived); SSE streaming supported.

Default port: `4864`

## Quick start

```js
import { FireworksAiServer } from "./services/fireworks-ai/src/server.js";

const server = new FireworksAiServer(4864);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the `openai` SDK at it:

```js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: "parlel-fireworks", baseURL: "http://127.0.0.1:4864/inference/v1" });
const res = await client.chat.completions.create({
  model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  messages: [{ role: "user", content: "hello" }],
});
```

## Access via MCP / preview URL

- Base URL: `http://127.0.0.1:4864/inference/v1`
- Health: `GET /health` → `{ "status": "ok" }`
- Auth: `Authorization: Bearer <key>` (any non-empty token).

## Implemented operations

- `POST /inference/v1/chat/completions` — OpenAI-compatible chat. Supports `stream: true` (SSE, `data: [DONE]`).
- `POST /inference/v1/completions` — legacy text completion.
- `POST /inference/v1/embeddings` — deterministic 768-dim embeddings.
- `GET /inference/v1/models` — model catalog (`accounts/fireworks/models/...`).

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
| `models` list | ✅ Supported |
| Deterministic, reproducible output | ✅ Supported |
| Real model inference | ✓ By design — Deterministic stub output — repeatable assertions, no API spend |
| Image/audio models, fine-tuning | ⟳ Roadmap |
| Tool/function calling, grammar mode | ◐ Accepted, not specially handled |

## Error codes & shapes

Errors use the OpenAI envelope: `{ "error": { "message", "type", "code" } }`.

| Status | When |
| --- | --- |
| `401` | missing/invalid `Authorization` |
| `400` | missing `model`/`messages`/`prompt`/`input` or bad JSON |
| `404` | unknown endpoint |

## Manifest

See `services/fireworks-ai/manifest.json`:

- name: `fireworks-ai`, port: `4864`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `FIREWORKS_API_KEY`, `FIREWORKS_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FIREWORKS_API_KEY=parlel-fireworks
FIREWORKS_BASE_URL=http://localhost:4864/inference/v1
```

<!-- parlel:testenv:end -->
